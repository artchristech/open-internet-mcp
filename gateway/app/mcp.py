"""Async stdio JSON-RPC client for the open-internet-mcp server.

Spawns the MCP server as a child process, speaks newline-delimited JSON-RPC
over stdin/stdout, multiplexes requests by id. Single shared client per
gateway process.
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
from typing import Any


class McpError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.data = data


class McpClient:
    def __init__(self, command: str | None = None):
        # Default to running the published package via npx so the gateway
        # is self-contained. Override via OPEN_INTERNET_MCP_CMD for local dev.
        self.command = command or os.environ.get(
            "OPEN_INTERNET_MCP_CMD",
            "npx -y open-internet-mcp",
        )
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._next_id: int = 1
        self._tools_cache: list[dict[str, Any]] | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        if self._proc is not None:
            return
        argv = shlex.split(self.command)
        self._proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        # Initialize per MCP handshake.
        await self._rpc(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "open-internet-gateway", "version": "0.1.0"},
            },
        )

    async def stop(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=2)
        except asyncio.TimeoutError:
            self._proc.kill()
        if self._reader_task:
            self._reader_task.cancel()
        self._proc = None

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                # Child exited; fail any pending requests.
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(McpError(-32000, "MCP server closed stdout"))
                self._pending.clear()
                return
            try:
                msg = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is None or mid not in self._pending:
                continue
            fut = self._pending.pop(mid)
            if "error" in msg:
                err = msg["error"]
                fut.set_exception(McpError(err.get("code", -1), err.get("message", "unknown"), err.get("data")))
            else:
                fut.set_result(msg.get("result", {}))

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._proc is None or self._proc.stdin is None:
            raise McpError(-32001, "MCP not started")
        async with self._lock:
            mid = self._next_id
            self._next_id += 1
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[mid] = fut
        frame = json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n"
        self._proc.stdin.write(frame.encode("utf-8"))
        await self._proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout=45)
        except asyncio.TimeoutError:
            self._pending.pop(mid, None)
            raise McpError(-32002, f"MCP call '{method}' timed out")

    async def list_tools(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        if self._tools_cache is None or refresh:
            res = await self._rpc("tools/list", {})
            self._tools_cache = list(res.get("tools", []))
        return self._tools_cache

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self._rpc("tools/call", {"name": name, "arguments": arguments})
