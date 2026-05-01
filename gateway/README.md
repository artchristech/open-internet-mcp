# open-internet-gateway

> HTTP + x402 in front of `open-internet-mcp`. 26 keyless public APIs as paid endpoints any agent on the internet can call.

## Why

`open-internet-mcp` is great inside an MCP client (Claude Desktop, Cursor, Cline, etc.). This gateway makes the same 26 tools reachable from **anything that can speak HTTP** — and adds an x402 payment layer so you can charge per call without an account system.

## Run it

```bash
# 1. Build the MCP server (from repo root)
npm install && npm run build

# 2. Run the gateway
cd gateway
pip install -e .
OPEN_INTERNET_MCP_CMD="node $PWD/../dist/index.js" \
  open-internet-gateway
```

Or via Docker (from repo root):

```bash
docker build -f gateway/Dockerfile -t open-internet-gateway .
docker run --rm -p 8088:8088 open-internet-gateway
```

## API

```
GET  /                  → metadata + tool list
GET  /healthz           → liveness
GET  /v1/tools          → catalog with input schemas + per-call prices
POST /v1/tools/{name}   → call a tool. JSON body = arguments.
```

When `X402_ENFORCE=1`, every `POST /v1/tools/...` returns `402 Payment Required` with an `accepts` block until you present a valid `X-PAYMENT` header. v0 verification is stubbed — `demo:<id>` is accepted and logged. Wire in the Coinbase x402 facilitator before flipping enforce on for real money.

## Pricing

| Tool category | Default | Notes |
|---|---|---|
| Most lookups | $0.001 | 1000 atomic units USDC |
| `wikidata_sparql`, `overpass_query`, `ipfs_cat` | $0.005 | upstream-heavy |

Override via env or future config file.

## Smoke test

```bash
cd gateway
python scripts/smoke.py
```

Spawns the gateway against a local MCP build and exercises the catalog, a real DNS-over-HTTPS call, and unknown-tool handling.

## License

MIT.
