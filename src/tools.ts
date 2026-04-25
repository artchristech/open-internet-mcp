import { z } from "zod";
import { safeFetch, clampStr, SafeFetchError } from "./safeFetch.js";

// Each tool: zod input schema + handler returning a string (text content payload).
// All network access goes through safeFetch with an explicit allowHosts list.

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  schema: S;
  call: (args: z.infer<S>) => Promise<string>;
}

const truncatedNote = (truncated: boolean) =>
  truncated ? "\n\n[response truncated to 512KB cap]" : "";

// 1. Wikidata SPARQL --------------------------------------------------------
const wikidataSparql: ToolDef = {
  name: "wikidata_sparql",
  title: "Wikidata SPARQL",
  description:
    "Run a read-only SPARQL query against Wikidata (query.wikidata.org). Returns JSON results. Best for structured world knowledge: people, places, organisations, taxonomic classes.",
  schema: z.object({
    query: z.string().min(1).max(8000).describe("SPARQL query (read-only)."),
  }),
  call: async ({ query }) => {
    if (/\b(INSERT|DELETE|DROP|CLEAR|LOAD|CREATE|COPY|MOVE|ADD)\b/i.test(query)) {
      throw new SafeFetchError("bad_input", "SPARQL update/management verbs are not allowed");
    }
    const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
    const r = await safeFetch(url, { allowHosts: ["query.wikidata.org"], accept: "application/sparql-results+json" });
    return r.text + truncatedNote(r.truncated);
  },
};

// 2. Wikipedia summary ------------------------------------------------------
const wikipediaSummary: ToolDef = {
  name: "wikipedia_summary",
  title: "Wikipedia summary",
  description:
    "Fetch the lead-section summary for a Wikipedia article by exact title. Use this after wikipedia_search if you need narrative text.",
  schema: z.object({
    title: z.string().min(1).max(200),
    lang: z.string().regex(/^[a-z]{2,3}(-[a-z]{2,8})?$/i).default("en"),
  }),
  call: async ({ title, lang }) => {
    const t = clampStr(title, 200);
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`;
    // Allow a small whitelist of common language hosts.
    const allow = [`${lang}.wikipedia.org`];
    const r = await safeFetch(url, { allowHosts: allow });
    return r.text + truncatedNote(r.truncated);
  },
};

// 3. Wikipedia search -------------------------------------------------------
const wikipediaSearch: ToolDef = {
  name: "wikipedia_search",
  title: "Wikipedia search",
  description:
    "Full-text search Wikipedia article titles and snippets. Returns matches with page IDs and excerpts.",
  schema: z.object({
    q: z.string().min(1).max(300),
    lang: z.string().regex(/^[a-z]{2,3}(-[a-z]{2,8})?$/i).default("en"),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  call: async ({ q, lang, limit }) => {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srsearch=${encodeURIComponent(
      q,
    )}&srlimit=${limit}`;
    const r = await safeFetch(url, { allowHosts: [`${lang}.wikipedia.org`] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 4. Overpass (OSM) ---------------------------------------------------------
const overpassQuery: ToolDef = {
  name: "overpass_query",
  title: "OpenStreetMap Overpass",
  description:
    "Query OpenStreetMap features with Overpass QL. Returns JSON. Use [out:json][timeout:25]; … out; pattern. Heavy queries may be rejected by the server.",
  schema: z.object({
    ql: z.string().min(1).max(8000).describe("Overpass QL source."),
  }),
  call: async ({ ql }) => {
    const r = await safeFetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      allowHosts: ["overpass-api.de"],
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: ql }),
      timeoutMs: 30_000,
    });
    return r.text + truncatedNote(r.truncated);
  },
};

// 5. Nominatim geocode (forward) -------------------------------------------
const nominatimGeocode: ToolDef = {
  name: "nominatim_geocode",
  title: "Nominatim geocode",
  description: "Forward-geocode a place name → lat/lon list using OpenStreetMap Nominatim.",
  schema: z.object({
    q: z.string().min(1).max(300),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  call: async ({ q, limit }) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=${limit}`;
    const r = await safeFetch(url, { allowHosts: ["nominatim.openstreetmap.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 6. Nominatim reverse ------------------------------------------------------
const nominatimReverse: ToolDef = {
  name: "nominatim_reverse",
  title: "Nominatim reverse",
  description: "Reverse-geocode a lat/lon → address using OpenStreetMap Nominatim.",
  schema: z.object({
    lat: z.number().gte(-90).lte(90),
    lon: z.number().gte(-180).lte(180),
    zoom: z.number().int().min(0).max(18).default(18),
  }),
  call: async ({ lat, lon, zoom }) => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=${zoom}`;
    const r = await safeFetch(url, { allowHosts: ["nominatim.openstreetmap.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 7. SEC EDGAR company submissions -----------------------------------------
const secEdgarCompany: ToolDef = {
  name: "sec_edgar_company",
  title: "SEC EDGAR submissions",
  description:
    "Fetch the recent filings index for a US public company by 10-digit CIK (zero-padded). Use cik_lookup-style search via the search endpoint if you only have a ticker.",
  schema: z.object({
    cik: z.string().regex(/^\d{1,10}$/, "CIK must be 1-10 digits"),
  }),
  call: async ({ cik }) => {
    const padded = cik.padStart(10, "0");
    const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
    const r = await safeFetch(url, { allowHosts: ["data.sec.gov"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 8. OpenAlex works ---------------------------------------------------------
const openalexSearch: ToolDef = {
  name: "openalex_search",
  title: "OpenAlex search",
  description:
    "Search 250M+ scholarly works (papers, datasets, books) on OpenAlex. Returns abstracts, citations, authors, institutions.",
  schema: z.object({
    q: z.string().min(1).max(500),
    per_page: z.number().int().min(1).max(25).default(10),
  }),
  call: async ({ q, per_page }) => {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${per_page}`;
    const r = await safeFetch(url, { allowHosts: ["api.openalex.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 9. arXiv search -----------------------------------------------------------
const arxivSearch: ToolDef = {
  name: "arxiv_search",
  title: "arXiv search",
  description:
    "Search arXiv preprints. Returns Atom XML with titles, authors, abstracts, and IDs. Use search_query syntax like 'all:transformers' or 'cat:cs.LG AND ti:diffusion'.",
  schema: z.object({
    search_query: z.string().min(1).max(500),
    max_results: z.number().int().min(1).max(50).default(10),
  }),
  call: async ({ search_query, max_results }) => {
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(search_query)}&max_results=${max_results}`;
    const r = await safeFetch(url, { allowHosts: ["export.arxiv.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 10. PubMed (NCBI E-utils) ------------------------------------------------
const pubmedSearch: ToolDef = {
  name: "pubmed_search",
  title: "PubMed search",
  description: "Search MEDLINE/PubMed. Returns PMIDs that you can pass to a follow-up esummary call.",
  schema: z.object({
    term: z.string().min(1).max(500),
    retmax: z.number().int().min(1).max(50).default(20),
  }),
  call: async ({ term, retmax }) => {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(
      term,
    )}&retmax=${retmax}`;
    const r = await safeFetch(url, { allowHosts: ["eutils.ncbi.nlm.nih.gov"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 11. Crossref DOI ----------------------------------------------------------
const crossrefDoi: ToolDef = {
  name: "crossref_doi",
  title: "Crossref DOI",
  description: "Look up canonical metadata + references for a DOI on Crossref.",
  schema: z.object({
    doi: z.string().min(3).max(200).regex(/^10\..+/, "DOI must start with 10."),
  }),
  call: async ({ doi }) => {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const r = await safeFetch(url, { allowHosts: ["api.crossref.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 12. OEIS ------------------------------------------------------------------
const oeisLookup: ToolDef = {
  name: "oeis_lookup",
  title: "OEIS lookup",
  description:
    "Online Encyclopedia of Integer Sequences. Pass a comma-separated prefix like '1,1,2,3,5,8' or an A-number like 'A000045'.",
  schema: z.object({
    q: z.string().min(1).max(200),
  }),
  call: async ({ q }) => {
    const url = `https://oeis.org/search?fmt=json&q=${encodeURIComponent(q)}`;
    const r = await safeFetch(url, { allowHosts: ["oeis.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 13. Public Ethereum RPC (read-only allowlist) -----------------------------
const ETH_RPC_ALLOW = new Set([
  "eth_blockNumber", "eth_chainId", "eth_gasPrice", "eth_feeHistory",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_getTransactionByHash", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionReceipt",
  "eth_getBlockByHash", "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber",
  "eth_call", "eth_estimateGas", "eth_getLogs",
  "net_version", "web3_clientVersion",
]);
const ethRpc: ToolDef = {
  name: "eth_rpc",
  title: "Public Ethereum RPC",
  description:
    "Call a read-only Ethereum JSON-RPC method against a public node (default cloudflare-eth.com). Only safe read methods are allowed; signing, admin, debug, and subscription methods are blocked.",
  schema: z.object({
    method: z.string().min(1).max(100),
    params: z.array(z.unknown()).max(8).default([]),
    endpoint: z
      .enum(["publicnode", "merkle", "mevblocker", "drpc"])
      .default("publicnode")
      .describe("Public RPC endpoint to use (all keyless)."),
  }),
  call: async ({ method, params, endpoint }) => {
    if (!ETH_RPC_ALLOW.has(method)) {
      throw new SafeFetchError("method_not_allowed", `eth_rpc method '${method}' is not on the read-only allowlist`);
    }
    const map: Record<string, string> = {
      "publicnode": "https://ethereum-rpc.publicnode.com",
      "merkle": "https://eth.merkle.io",
      "mevblocker": "https://rpc.mevblocker.io",
      "drpc": "https://eth.drpc.org",
    };
    const url = map[endpoint];
    const allow = [new URL(url).hostname];
    const r = await safeFetch(url, {
      method: "POST",
      allowHosts: allow,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return r.text + truncatedNote(r.truncated);
  },
};

// 14. Web3.bio identity (ENS + Lens + Farcaster) ---------------------------
const web3Identity: ToolDef = {
  name: "web3_identity",
  title: "Web3 identity (ENS / Lens / Farcaster)",
  description:
    "Resolve a Web3 handle (ENS name, Lens handle, Farcaster username, or 0x address) to identity records across protocols via web3.bio. Best-effort, public, no auth.",
  schema: z.object({
    handle: z.string().min(1).max(200),
  }),
  call: async ({ handle }) => {
    const url = `https://api.web3.bio/profile/${encodeURIComponent(handle)}`;
    const r = await safeFetch(url, { allowHosts: ["api.web3.bio"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 15. Open-Meteo forecast --------------------------------------------------
const openMeteo: ToolDef = {
  name: "open_meteo_forecast",
  title: "Open-Meteo forecast",
  description:
    "Hourly + daily weather forecast for any lat/lon. Pass comma-separated 'hourly' / 'daily' variable lists per Open-Meteo docs (e.g. 'temperature_2m,precipitation').",
  schema: z.object({
    latitude: z.number().gte(-90).lte(90),
    longitude: z.number().gte(-180).lte(180),
    hourly: z.string().max(500).optional(),
    daily: z.string().max(500).optional(),
    timezone: z.string().max(50).default("auto"),
    forecast_days: z.number().int().min(1).max(16).default(3),
  }),
  call: async (a) => {
    const params = new URLSearchParams({
      latitude: String(a.latitude),
      longitude: String(a.longitude),
      timezone: a.timezone,
      forecast_days: String(a.forecast_days),
    });
    if (a.hourly) params.set("hourly", a.hourly);
    if (a.daily) params.set("daily", a.daily);
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    const r = await safeFetch(url, { allowHosts: ["api.open-meteo.com"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 16. USGS Earthquakes -----------------------------------------------------
const usgsQuakes: ToolDef = {
  name: "usgs_quakes",
  title: "USGS earthquakes",
  description:
    "Query the USGS earthquake catalog. Time bounds are ISO8601; minmagnitude in Richter.",
  schema: z.object({
    starttime: z.string().min(4).max(40).optional(),
    endtime: z.string().min(4).max(40).optional(),
    minmagnitude: z.number().min(0).max(10).default(4.5),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  call: async (a) => {
    const params = new URLSearchParams({
      format: "geojson",
      minmagnitude: String(a.minmagnitude),
      limit: String(a.limit),
      orderby: "time",
    });
    if (a.starttime) params.set("starttime", a.starttime);
    if (a.endtime) params.set("endtime", a.endtime);
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;
    const r = await safeFetch(url, { allowHosts: ["earthquake.usgs.gov"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 17. NWS alerts ------------------------------------------------------------
const nwsAlerts: ToolDef = {
  name: "nws_alerts",
  title: "US National Weather Service alerts",
  description:
    "Active US weather alerts. Filter by 2-letter state, point (lat,lon), or zone. Requires identifying User-Agent (handled).",
  schema: z.object({
    area: z.string().regex(/^[A-Z]{2}$/).optional().describe("2-letter US state code"),
    point: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional().describe("lat,lon"),
  }),
  call: async ({ area, point }) => {
    const params = new URLSearchParams();
    if (area) params.set("area", area);
    if (point) params.set("point", point);
    const url = `https://api.weather.gov/alerts/active${params.toString() ? "?" + params : ""}`;
    const r = await safeFetch(url, {
      allowHosts: ["api.weather.gov"],
      accept: "application/geo+json",
    });
    return r.text + truncatedNote(r.truncated);
  },
};

// 18. openFDA drug events --------------------------------------------------
const openFdaDrug: ToolDef = {
  name: "openfda_drug_events",
  title: "openFDA drug adverse events",
  description: "Search FAERS adverse-event reports via openFDA. Use search syntax like 'patient.drug.medicinalproduct:aspirin'.",
  schema: z.object({
    search: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(100).default(10),
  }),
  call: async ({ search, limit }) => {
    const url = `https://api.fda.gov/drug/event.json?search=${encodeURIComponent(search)}&limit=${limit}`;
    const r = await safeFetch(url, { allowHosts: ["api.fda.gov"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 19. ClinicalTrials.gov ---------------------------------------------------
const clinicalTrials: ToolDef = {
  name: "clinicaltrials_search",
  title: "ClinicalTrials.gov v2",
  description: "Search active and completed clinical trials registered with ClinicalTrials.gov.",
  schema: z.object({
    query: z.string().min(1).max(500),
    pageSize: z.number().int().min(1).max(50).default(10),
  }),
  call: async ({ query, pageSize }) => {
    const url = `https://clinicaltrials.gov/api/v2/studies?format=json&query.term=${encodeURIComponent(
      query,
    )}&pageSize=${pageSize}`;
    const r = await safeFetch(url, { allowHosts: ["clinicaltrials.gov"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 20. GitHub search (unauth) -----------------------------------------------
const githubSearch: ToolDef = {
  name: "github_search",
  title: "GitHub search",
  description:
    "Search GitHub repositories, code, issues, or users (unauthenticated; ~10 req/min). type=repositories|code|issues|users.",
  schema: z.object({
    type: z.enum(["repositories", "code", "issues", "users"]).default("repositories"),
    q: z.string().min(1).max(500),
    per_page: z.number().int().min(1).max(20).default(10),
  }),
  call: async ({ type, q, per_page }) => {
    const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(q)}&per_page=${per_page}`;
    const r = await safeFetch(url, {
      allowHosts: ["api.github.com"],
      accept: "application/vnd.github+json",
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
    });
    return r.text + truncatedNote(r.truncated);
  },
};

// 21. crt.sh certificate transparency --------------------------------------
const crtSh: ToolDef = {
  name: "crt_sh_certs",
  title: "Certificate Transparency search",
  description:
    "Find all TLS certificates ever issued for a domain (or wildcard like %.example.com) via crt.sh.",
  schema: z.object({
    q: z.string().min(1).max(255),
  }),
  call: async ({ q }) => {
    const url = `https://crt.sh/?q=${encodeURIComponent(q)}&output=json`;
    const r = await safeFetch(url, { allowHosts: ["crt.sh"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 22. RDAP domain ----------------------------------------------------------
const rdapDomain: ToolDef = {
  name: "rdap_domain",
  title: "RDAP domain lookup",
  description: "Modern WHOIS-equivalent: registrar, registration / expiry dates, abuse contacts.",
  schema: z.object({
    domain: z.string().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/),
  }),
  call: async ({ domain }) => {
    const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    const r = await safeFetch(url, { allowHosts: ["rdap.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 23. DNS over HTTPS -------------------------------------------------------
const dnsDoh: ToolDef = {
  name: "dns_doh",
  title: "DNS over HTTPS",
  description: "Resolve a DNS record via Cloudflare DoH. type defaults to A.",
  schema: z.object({
    name: z.string().min(1).max(253).regex(/^[a-zA-Z0-9._-]+$/),
    type: z.enum(["A", "AAAA", "MX", "TXT", "NS", "CNAME", "CAA", "SOA", "SRV", "PTR"]).default("A"),
  }),
  call: async ({ name, type }) => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
    const r = await safeFetch(url, {
      allowHosts: ["cloudflare-dns.com"],
      accept: "application/dns-json",
    });
    return r.text + truncatedNote(r.truncated);
  },
};

// 24. IPFS cat (size-capped) -----------------------------------------------
const ipfsCat: ToolDef = {
  name: "ipfs_cat",
  title: "IPFS read",
  description:
    "Fetch the contents of an IPFS CID via the public ipfs.io gateway. Capped at 256KB; use only for text-ish payloads.",
  schema: z.object({
    cid: z.string().min(46).max(80).regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$/, "must be a v0 (Qm…) or v1 (b…) CID"),
    path: z.string().max(500).regex(/^([A-Za-z0-9_.\-/]*)$/).optional(),
  }),
  call: async ({ cid, path }) => {
    const suffix = path ? `/${path.replace(/^\//, "")}` : "";
    const url = `https://ipfs.io/ipfs/${cid}${suffix}`;
    const r = await safeFetch(url, {
      allowHosts: ["ipfs.io"],
      maxBytes: 256 * 1024,
      timeoutMs: 25_000,
    });
    return r.text + truncatedNote(r.truncated);
  },
};

// 25. Bluesky / ATProto search ---------------------------------------------
const blueskySearch: ToolDef = {
  name: "bluesky_search",
  title: "Bluesky post search",
  description: "Search public posts on Bluesky / ATProto via the public AppView. No auth required.",
  schema: z.object({
    q: z.string().min(1).max(300),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  call: async ({ q, limit }) => {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(
      q,
    )}&limit=${limit}`;
    const r = await safeFetch(url, { allowHosts: ["public.api.bsky.app"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 26. Software Heritage ----------------------------------------------------
const softwareHeritage: ToolDef = {
  name: "software_heritage_origin",
  title: "Software Heritage origin",
  description:
    "Look up an origin (e.g. a public git URL) in the Software Heritage archive — every public commit ever pushed.",
  schema: z.object({
    origin_url: z.string().url().max(500),
  }),
  call: async ({ origin_url }) => {
    const url = `https://archive.softwareheritage.org/api/1/origin/${encodeURIComponent(origin_url)}/get/`;
    const r = await safeFetch(url, { allowHosts: ["archive.softwareheritage.org"] });
    return r.text + truncatedNote(r.truncated);
  },
};

// 27. CoinGecko-free fallback removed — keeping at 26 raw, exposing 25 by
// dropping wikipedia_search vs summary collapse? No — both useful, ship 26.

export const TOOLS: ToolDef[] = [
  wikidataSparql,
  wikipediaSummary,
  wikipediaSearch,
  overpassQuery,
  nominatimGeocode,
  nominatimReverse,
  secEdgarCompany,
  openalexSearch,
  arxivSearch,
  pubmedSearch,
  crossrefDoi,
  oeisLookup,
  ethRpc,
  web3Identity,
  openMeteo,
  usgsQuakes,
  nwsAlerts,
  openFdaDrug,
  clinicalTrials,
  githubSearch,
  crtSh,
  rdapDomain,
  dnsDoh,
  ipfsCat,
  blueskySearch,
  softwareHeritage,
];
