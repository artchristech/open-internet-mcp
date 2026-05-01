"""End-to-end smoke against a running gateway. Spawns the gateway itself.

Run: python -m gateway.scripts.smoke   (or `python scripts/smoke.py`)
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    repo = here.parent
    dist = repo / "dist" / "index.js"
    if not dist.exists():
        print(f"FAIL: build the MCP first ({dist})")
        return 1

    port = find_free_port()
    env = {
        **os.environ,
        "PORT": str(port),
        "OPEN_INTERNET_MCP_CMD": f"node {dist}",
        "X402_ENFORCE": "0",  # default-open for the smoke
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=here,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    cases: list[tuple[str, bool, str]] = []
    try:
        # Wait for healthz.
        base = f"http://127.0.0.1:{port}"
        deadline = time.time() + 30
        ok = False
        while time.time() < deadline:
            try:
                r = httpx.get(f"{base}/healthz", timeout=2)
                if r.status_code == 200:
                    ok = True
                    break
            except Exception:
                time.sleep(0.4)
        cases.append(("gateway boots", ok, ""))
        if not ok:
            return _report(cases, proc)

        # tools/list.
        r = httpx.get(f"{base}/v1/tools", timeout=10)
        cases.append((
            "GET /v1/tools returns 26+",
            r.status_code == 200 and len(r.json().get("tools", [])) >= 25,
            f"status={r.status_code} len={len(r.json().get('tools', [])) if r.status_code == 200 else 0}",
        ))

        # Call dns_doh — quick and reliable.
        r = httpx.post(
            f"{base}/v1/tools/dns_doh",
            json={"name": "example.com", "type": "A"},
            timeout=20,
        )
        body = r.json()
        cases.append((
            "POST dns_doh resolves",
            r.status_code == 200 and not body.get("isError") and '"Status":0' in body.get("result", ""),
            f"status={r.status_code} err={body.get('isError')}",
        ))

        # Negative: unknown tool.
        r = httpx.post(f"{base}/v1/tools/no_such_tool", json={}, timeout=5)
        cases.append((
            "unknown tool returns 404",
            r.status_code == 404,
            f"status={r.status_code}",
        ))

        # x402 path: enforce mode returns 402.
        # We'd need to restart with X402_ENFORCE=1 — assert structure of build_402 instead by hitting a separate proc.
        # Skip in-line; covered by unit pattern in payment.py.

        return _report(cases, proc)
    finally:
        try:
            os.kill(proc.pid, signal.SIGTERM)
            proc.wait(timeout=3)
        except Exception:
            try: proc.kill()
            except Exception: pass


def _report(cases, proc) -> int:
    ok = sum(1 for _, p, _ in cases if p)
    for name, p, info in cases:
        print(f"{'OK  ' if p else 'FAIL'} {name}  ::  {info}")
    print(f"\n{ok}/{len(cases)} passed")
    return 0 if ok == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
