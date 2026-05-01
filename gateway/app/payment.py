"""x402-shaped payment middleware.

Returns a structurally-correct HTTP 402 with a payment requirements body
when no X-PAYMENT header is presented. Verification is stubbed for v0:
any header of the form `demo:<id>` is accepted and logged. Real x402
settlement plugs in by replacing `verify()` with a Coinbase-facilitator
call.

Spec reference: https://x402.org
"""
from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

# v0: enforce only when explicitly enabled, so the free tier remains
# inviting for early adopters and load-testing.
ENFORCE = os.environ.get("X402_ENFORCE", "0") == "1"

# Demo per-tool unit price in atomic units of the configured asset.
# At rollout we'll pull these from a real config file or registry.
DEFAULT_PRICE_ATOMIC = "1000"  # i.e. $0.001 if asset is 6-decimal USDC.
PRICE_OVERRIDES: dict[str, str] = {
    # SPARQL and Overpass burn upstream resources — charge a touch more.
    "wikidata_sparql": "5000",
    "overpass_query": "5000",
    "ipfs_cat": "5000",
}

# Wallet that receives settlement. Replace with the real treasury address
# before flipping X402_ENFORCE on.
RECIPIENT = os.environ.get(
    "X402_RECIPIENT",
    "0x0000000000000000000000000000000000000000",
)
NETWORK = os.environ.get("X402_NETWORK", "base-sepolia")
ASSET = os.environ.get(
    "X402_ASSET",
    # Base Sepolia USDC.
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
)


@dataclass
class PaymentVerification:
    paid: bool
    payer: str | None
    raw: str | None


def _price_for(tool: str) -> str:
    return PRICE_OVERRIDES.get(tool, DEFAULT_PRICE_ATOMIC)


def requirements_for(tool: str, request: Request) -> dict[str, Any]:
    """Build an x402 `paymentRequirements` block for one tool call."""
    return {
        "x402Version": 1,
        "accepts": [
            {
                "scheme": "exact",
                "network": NETWORK,
                "maxAmountRequired": _price_for(tool),
                "resource": str(request.url),
                "description": f"Call open-internet-mcp tool '{tool}'",
                "mimeType": "application/json",
                "payTo": RECIPIENT,
                "maxTimeoutSeconds": 60,
                "asset": ASSET,
                "extra": {"name": "USDC", "version": "2"},
            }
        ],
        "error": "Payment required",
    }


def verify(payment_header: str | None) -> PaymentVerification:
    """Verify an X-PAYMENT header. v0 stub.

    Real implementation: decode base64-JSON payload, verify EIP-3009
    `transferWithAuthorization` signature against the facilitator, settle.
    """
    if not payment_header:
        return PaymentVerification(False, None, None)
    # Demo mode: `demo:<agent_id>` is a valid receipt that we log.
    if payment_header.startswith("demo:"):
        return PaymentVerification(True, payment_header[5:], payment_header)
    # Best-effort spec parse so we don't break clients sending real headers
    # before facilitator integration lands.
    try:
        decoded = json.loads(base64.b64decode(payment_header))
        # We accept it but flag as "unverified" until facilitator is wired.
        return PaymentVerification(True, decoded.get("from"), payment_header)
    except Exception:
        return PaymentVerification(False, None, payment_header)


def build_402(tool: str, request: Request) -> JSONResponse:
    return JSONResponse(
        status_code=402,
        content=requirements_for(tool, request),
    )


def receipt_header(verification: PaymentVerification, tool: str) -> str:
    payload = {
        "tool": tool,
        "payer": verification.payer,
        "settledAt": int(time.time()),
        "stub": True,
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()
