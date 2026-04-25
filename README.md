# open-internet-mcp

> One MCP server. 26 keyless public APIs. The crown jewels of the open internet, exposed as agent tools.

No API keys. No accounts. No rate-limit dance. Drop it into any MCP-aware client and your agent gains read access to Wikidata, OpenStreetMap, SEC EDGAR, OpenAlex, public Ethereum, GitHub search, Certificate Transparency, USGS, openFDA, and more — twenty-six tools total, all behind a single allowlisted, size-capped, timeout-bounded fetcher.

## Install

```bash
npx open-internet-mcp        # once published
```

Or run from source:

```bash
git clone <this repo> && cd open-internet-mcp
npm install
npm run build
npm start
```

## Wire it into Claude Desktop / Claude Code

`~/Library/Application Support/Claude/claude_desktop_config.json` (Mac):

```json
{
  "mcpServers": {
    "open-internet": {
      "command": "npx",
      "args": ["-y", "open-internet-mcp"]
    }
  }
}
```

For Claude Code: `claude mcp add open-internet -- npx -y open-internet-mcp`.

## Tools

| Tool | What it does |
|---|---|
| `wikidata_sparql` | Read-only SPARQL over Wikidata |
| `wikipedia_summary` | Lead-section summary by title |
| `wikipedia_search` | Full-text search of articles |
| `overpass_query` | Query OpenStreetMap features (Overpass QL) |
| `nominatim_geocode` | Forward geocode place → lat/lon |
| `nominatim_reverse` | Reverse geocode lat/lon → address |
| `sec_edgar_company` | All filings for a US public company by CIK |
| `openalex_search` | Search 250M+ scholarly works |
| `arxiv_search` | Search arXiv preprints |
| `pubmed_search` | Search MEDLINE/PubMed |
| `crossref_doi` | DOI → canonical metadata + references |
| `oeis_lookup` | Online Encyclopedia of Integer Sequences |
| `eth_rpc` | Read-only Ethereum JSON-RPC (allowlisted methods) |
| `web3_identity` | Resolve ENS / Lens / Farcaster identity |
| `open_meteo_forecast` | Hourly + daily weather for any lat/lon |
| `usgs_quakes` | Recent earthquakes from USGS catalog |
| `nws_alerts` | Active US weather alerts |
| `openfda_drug_events` | FAERS adverse-event reports |
| `clinicaltrials_search` | ClinicalTrials.gov v2 |
| `github_search` | Search GitHub repos / code / issues / users |
| `crt_sh_certs` | Every TLS cert ever issued for a domain |
| `rdap_domain` | Modern WHOIS via RDAP |
| `dns_doh` | DNS-over-HTTPS lookup (Cloudflare) |
| `ipfs_cat` | Read an IPFS CID via public gateway (256KB cap) |
| `bluesky_search` | Search public Bluesky / ATProto posts |
| `software_heritage_origin` | Look up an origin in the SH archive |

## Security model

Every tool routes through `safeFetch` with:

- **Host allowlist** — each tool declares the exact hostname(s) it may contact. SSRF-resistant; user inputs never determine the destination host.
- **Timeout** — 15s default, 25–30s for Overpass / IPFS / SPARQL.
- **Size cap** — 512KB per response (256KB for IPFS), streamed and truncated.
- **No embedded credentials** — URLs with `user:pass@` are rejected.
- **Identifying User-Agent** — required by NWS, Nominatim, Crossref policies.
- **Read-only enforcement** — `eth_rpc` blocks signing / admin / debug / subscription methods; `wikidata_sparql` blocks `INSERT/DELETE/DROP/CLEAR/LOAD/CREATE/COPY/MOVE/ADD`.
- **Strict input schemas** — every argument is parsed by Zod before reaching the network. Bad enums, oversized payloads, and control characters are rejected with a structured error.

The server speaks stdio JSON-RPC only; it opens no listening sockets and stores no state.

## Smoke test

```bash
npm run build && npm run smoke
```

Hits live endpoints (DNS, ETH RPC, Wikidata) and exercises the negative paths.

## License

MIT.
