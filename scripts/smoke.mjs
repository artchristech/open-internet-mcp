// Spawns the built server and exercises a few tools end-to-end via stdio.
// Run: node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map(); // id -> { resolve, reject }

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error("bad frame:", line); continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function main() {
  let ok = 0, fail = 0;
  const cases = [];

  await withTimeout(rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  }), 5_000, "initialize");

  const list = await withTimeout(rpc("tools/list", {}), 5_000, "tools/list");
  const names = (list.result?.tools ?? []).map((t) => t.name);
  cases.push(["tools/list count", names.length >= 25, `got ${names.length}`]);
  cases.push(["wikidata_sparql registered", names.includes("wikidata_sparql"), ""]);
  cases.push(["eth_rpc registered", names.includes("eth_rpc"), ""]);
  cases.push(["dns_doh registered", names.includes("dns_doh"), ""]);

  // Live calls — these hit the real internet.
  const dns = await withTimeout(
    rpc("tools/call", { name: "dns_doh", arguments: { name: "example.com", type: "A" } }),
    20_000,
    "dns_doh",
  );
  const dnsText = dns.result?.content?.[0]?.text ?? "";
  cases.push(["dns_doh resolved", dnsText.includes('"Status":0'), dnsText.slice(0, 120)]);

  const eth = await withTimeout(
    rpc("tools/call", { name: "eth_rpc", arguments: { method: "eth_blockNumber", params: [] } }),
    20_000,
    "eth_rpc",
  );
  const ethText = eth.result?.content?.[0]?.text ?? "";
  cases.push(["eth_rpc returned hex block", /"result":"0x[0-9a-fA-F]+"/.test(ethText), ethText.slice(0, 160)]);

  // Negative test: blocked method should error cleanly.
  const blocked = await withTimeout(
    rpc("tools/call", { name: "eth_rpc", arguments: { method: "eth_sendTransaction", params: [] } }),
    10_000,
    "eth_rpc blocked",
  );
  cases.push([
    "eth_rpc blocks write methods",
    blocked.result?.isError === true && /method_not_allowed/.test(blocked.result?.content?.[0]?.text ?? ""),
    JSON.stringify(blocked.result).slice(0, 160),
  ]);

  // SPARQL: tiny query.
  const wd = await withTimeout(
    rpc("tools/call", {
      name: "wikidata_sparql",
      arguments: { query: "SELECT ?item WHERE { wd:Q42 wdt:P31 ?item } LIMIT 5" },
    }),
    25_000,
    "wikidata_sparql",
  );
  const wdText = wd.result?.content?.[0]?.text ?? "";
  cases.push(["wikidata_sparql returned bindings", wdText.includes("bindings"), wdText.slice(0, 160)]);

  // SPARQL injection block.
  const wdBad = await withTimeout(
    rpc("tools/call", { name: "wikidata_sparql", arguments: { query: "INSERT DATA { <a> <b> <c> }" } }),
    5_000,
    "wikidata_sparql blocked",
  );
  cases.push([
    "wikidata_sparql blocks updates",
    wdBad.result?.isError === true && /not allowed/i.test(wdBad.result?.content?.[0]?.text ?? ""),
    JSON.stringify(wdBad.result).slice(0, 160),
  ]);

  // Schema validation: bad input.
  const badArgs = await withTimeout(
    rpc("tools/call", { name: "dns_doh", arguments: { name: "example.com", type: "INVALID" } }),
    5_000,
    "schema validation",
  );
  cases.push([
    "zod rejects bad enum",
    badArgs.result?.isError === true && /invalid arguments/i.test(badArgs.result?.content?.[0]?.text ?? ""),
    JSON.stringify(badArgs.result).slice(0, 160),
  ]);

  for (const [name, pass, info] of cases) {
    if (pass) { ok++; console.log(`OK   ${name}`); }
    else      { fail++; console.log(`FAIL ${name}  ::  ${info}`); }
  }
  console.log(`\n${ok}/${ok + fail} passed`);

  child.stdin.end();
  child.kill();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke failed:", e);
  child.kill();
  process.exit(1);
});
