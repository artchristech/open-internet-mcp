"""FastAPI gateway: HTTP + x402 in front of open-internet-mcp.

Endpoints:
  GET  /                 — landing JSON
  GET  /healthz          — liveness
  GET  /v1/tools         — catalog (mirrors MCP tools/list, plus prices)
  POST /v1/tools/{name}  — call a tool. 402 unless X402_ENFORCE=0 or
                           a valid X-PAYMENT header is presented.
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .mcp import McpClient, McpError
from . import payment

log = logging.getLogger("open-internet-gateway")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

mcp = McpClient()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("starting MCP child: %s", mcp.command)
    await mcp.start()
    tools = await mcp.list_tools()
    log.info("MCP ready: %d tools", len(tools))
    try:
        yield
    finally:
        await mcp.stop()


app = FastAPI(
    title="Open Internet Gateway",
    version="0.1.0",
    description=(
        "HTTP + x402 gateway around open-internet-mcp. 26 keyless public APIs as paid endpoints."
    ),
    lifespan=lifespan,
)


@app.get("/")
async def root() -> dict[str, Any]:
    tools = await mcp.list_tools()
    return {
        "name": "open-internet-gateway",
        "version": "0.1.0",
        "x402": {
            "enforce": payment.ENFORCE,
            "network": payment.NETWORK,
            "asset": payment.ASSET,
            "recipient": payment.RECIPIENT,
        },
        "tools": [t["name"] for t in tools],
        "docs": "/docs",
    }


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/tools")
async def list_tools() -> dict[str, Any]:
    tools = await mcp.list_tools()
    return {
        "tools": [
            {
                "name": t["name"],
                "title": t.get("title"),
                "description": t.get("description"),
                "inputSchema": t.get("inputSchema"),
                "priceAtomic": payment._price_for(t["name"]),
                "asset": payment.ASSET,
                "network": payment.NETWORK,
            }
            for t in tools
        ]
    }


@app.post("/v1/tools/{name}")
async def call_tool(name: str, request: Request) -> Any:
    tools = await mcp.list_tools()
    tool_names = {t["name"] for t in tools}
    if name not in tool_names:
        raise HTTPException(status_code=404, detail=f"unknown tool: {name}")

    # Read body as JSON, default to empty args.
    try:
        body = await request.body()
        args = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(args, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object of arguments")

    # x402 gate.
    verification = payment.verify(request.headers.get("X-PAYMENT"))
    if payment.ENFORCE and not verification.paid:
        return payment.build_402(name, request)

    try:
        result = await mcp.call_tool(name, args)
    except McpError as e:
        raise HTTPException(status_code=502, detail=f"mcp_error: {e.code} {e}")

    is_error = bool(result.get("isError"))
    content = result.get("content", [])
    text = ""
    if content and isinstance(content, list):
        first = content[0]
        if isinstance(first, dict):
            text = first.get("text", "")

    headers: dict[str, str] = {}
    if verification.paid:
        headers["X-PAYMENT-RESPONSE"] = payment.receipt_header(verification, name)

    return JSONResponse(
        status_code=200 if not is_error else 422,
        headers=headers,
        content={
            "tool": name,
            "isError": is_error,
            "result": text,
            "raw": result,
        },
    )


def run() -> None:
    """Entrypoint registered as `open-internet-gateway` in pyproject."""
    import os
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8088")),
        log_level="info",
    )


if __name__ == "__main__":
    run()
