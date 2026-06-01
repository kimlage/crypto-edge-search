/**
 * TRACK OC3 — DeFi / DEX / CHAIN-level capital ROTATION at $0 (DefiLlama).
 *
 * FEASIBILITY + PROOF-OF-CONCEPT. We PROVE (not describe) that DefiLlama's
 * free, NO-KEY REST API lets us SEE capital rotating between L1/L2 ecosystems
 * by measuring each chain's share of total DeFi TVL over time.
 *
 * Mechanism: TVL-share rotation between chains is the on-chain analog of the
 * cross-tier rotation the user hypothesized. Unlike price/volume, TVL is a
 * direct *flow / stock of capital* measurement — when ETH's TVL share falls
 * while Solana's rises, that is literally dollars rotating between ecosystems.
 *
 * Endpoints exercised (all https://api.llama.fi, NO API key):
 *   1. /v2/chains                          -> current TVL snapshot per chain (to pick top chains)
 *   2. /v2/historicalChainTvl/{chain}      -> daily TVL time-series per chain (deep history)
 *   3. /overview/dexs                       -> DEX volume overview (chain-level dollar flow)
 *   4. https://stablecoins.llama.fi/stablecoinchains -> stablecoin $ supply per chain
 *
 * Also probed (key-gated, documented, NOT fetched as data): The Graph
 * decentralized gateway (needs key) and Dune (needs key) — see oc3-keyed-probe.ts.
 *
 * POC discipline: we keep payloads SMALL — only a handful of chains, and we
 * DOWNSAMPLE the per-chain daily series to a few hundred rows max before
 * writing, so we prove access + shape + depth without hoarding data.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-scout/oc3-defillama-poc.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT_DIR = resolve(ROOT, "output/onchain-scout/oc3-defillama");
mkdirSync(OUT_DIR, { recursive: true });

const DAY = 86_400;
const log = (...a: unknown[]) => console.log(...a);

type FetchResult = {
  url: string;
  status: number;
  ms: number;
  bytes: number;
  json: unknown;
};

async function getJSON(url: string): Promise<FetchResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "oc3-onchain-scout/1.0" },
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 200);
  }
  return { url, status: res.status, ms, bytes: text.length, json };
}

// Chains we care about for cross-ecosystem rotation (majors + L2s + alt-L1s).
const TARGET_CHAINS = [
  "Ethereum",
  "Solana",
  "BSC",
  "Arbitrum",
  "Base",
  "Tron",
  "Polygon",
  "Avalanche",
];

function isoDay(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

// Downsample a daily series to ~maxRows evenly spaced points (POC: prove shape+depth).
function downsample<T>(arr: T[], maxRows: number): T[] {
  if (arr.length <= maxRows) return arr;
  const step = Math.ceil(arr.length / maxRows);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

async function main() {
  const rateLog: Array<{ url: string; status: number; ms: number; bytes: number }> = [];
  const note = (r: FetchResult) => {
    rateLog.push({ url: r.url, status: r.status, ms: r.ms, bytes: r.bytes });
    log(`  [${r.status}] ${r.ms}ms ${r.bytes}B  ${r.url}`);
  };

  // ---- 1. Current TVL snapshot per chain (no key) ----
  log("\n=== 1. /v2/chains  (current TVL snapshot per chain) ===");
  const chainsRes = await getJSON("https://api.llama.fi/v2/chains");
  note(chainsRes);
  const chains = chainsRes.json as Array<{ name: string; tvl: number; tokenSymbol: string | null }>;
  const ranked = [...chains].filter((c) => typeof c.tvl === "number").sort((a, b) => b.tvl - a.tvl);
  const top15 = ranked.slice(0, 15).map((c) => ({ name: c.name, tvl: Math.round(c.tvl) }));
  log("  Top 15 chains by current TVL:");
  for (const c of top15) log(`    ${c.name.padEnd(14)} $${(c.tvl / 1e9).toFixed(2)}B`);

  // ---- 2. Historical daily TVL per target chain (deep history, no key) ----
  log("\n=== 2. /v2/historicalChainTvl/{chain}  (daily TVL series per chain) ===");
  const perChain: Record<
    string,
    { firstDay: string; lastDay: string; nDays: number; lastTvl: number; sampled: Array<{ date: string; tvl: number }> }
  > = {};

  for (const chain of TARGET_CHAINS) {
    const r = await getJSON(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`);
    note(r);
    if (r.status !== 200 || !Array.isArray(r.json)) {
      log(`    !! ${chain} did not return an array`);
      continue;
    }
    const series = (r.json as Array<{ date: number; tvl: number }>).filter(
      (p) => p && typeof p.date === "number" && typeof p.tvl === "number",
    );
    if (series.length === 0) continue;
    const first = series[0];
    const last = series[series.length - 1];
    // keep only meaningful (>0) start for depth reporting
    const firstNonZero = series.find((p) => p.tvl > 0) ?? first;
    const sampled = downsample(series, 200).map((p) => ({ date: isoDay(p.date), tvl: Math.round(p.tvl) }));
    perChain[chain] = {
      firstDay: isoDay(firstNonZero.date),
      lastDay: isoDay(last.date),
      nDays: series.length,
      lastTvl: Math.round(last.tvl),
      sampled,
    };
    log(
      `    ${chain.padEnd(11)} ${series.length} daily pts | first>$0 ${isoDay(firstNonZero.date)} -> ${isoDay(
        last.date,
      )} | last TVL $${(last.tvl / 1e9).toFixed(2)}B`,
    );
  }

  // ---- 3. Build a ROTATION matrix: each chain's SHARE of total TVL on common dates ----
  log("\n=== 3. ROTATION SIGNAL: chain share of total DeFi TVL over time ===");
  // Re-fetch full (un-downsampled) series for the rotation math on a common monthly grid.
  const fullSeries: Record<string, Map<string, number>> = {};
  for (const chain of Object.keys(perChain)) {
    const r = await getJSON(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`);
    rateLog.push({ url: r.url, status: r.status, ms: r.ms, bytes: r.bytes });
    const series = (r.json as Array<{ date: number; tvl: number }>) ?? [];
    const m = new Map<string, number>();
    for (const p of series) {
      // snap to first-of-month for a clean cross-chain rotation grid
      const d = new Date(p.date * 1000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      m.set(key, p.tvl); // last obs in month wins
    }
    fullSeries[chain] = m;
  }
  const allMonths = Array.from(
    new Set(Object.values(fullSeries).flatMap((m) => Array.from(m.keys()))),
  ).sort();
  // sample a few representative months to show rotation
  const showMonths = downsample(allMonths, 18);
  const rotationRows: Array<Record<string, string>> = [];
  for (const mo of showMonths) {
    const vals: Record<string, number> = {};
    let total = 0;
    for (const chain of Object.keys(fullSeries)) {
      const v = fullSeries[chain].get(mo) ?? 0;
      vals[chain] = v;
      total += v;
    }
    if (total <= 0) continue;
    const row: Record<string, string> = { month: mo, total_TVL: `$${(total / 1e9).toFixed(1)}B` };
    for (const chain of Object.keys(fullSeries)) {
      row[chain] = `${((vals[chain] / total) * 100).toFixed(1)}%`;
    }
    rotationRows.push(row);
  }
  log("  Chain share of total TVL across the target basket (rotation is visible in the columns):");
  // pretty print a compact table
  const cols = ["month", "total_TVL", ...Object.keys(fullSeries)];
  log("  " + cols.map((c) => c.slice(0, 9).padEnd(10)).join(""));
  for (const row of rotationRows) {
    log("  " + cols.map((c) => String(row[c] ?? "").padEnd(10)).join(""));
  }

  // ---- 4. DEX volume overview (chain-level dollar throughput, no key) ----
  log("\n=== 4. /overview/dexs  (DEX volume — chain-level dollar flow) ===");
  // exclude the heavy breakdown to keep it light
  const dexRes = await getJSON(
    "https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true",
  );
  note(dexRes);
  const dex = dexRes.json as {
    total24h?: number;
    total7d?: number;
    totalAllTime?: number;
    protocols?: Array<{ name: string; chains: string[]; total24h: number }>;
  };
  log(`  DEX total24h=$${((dex.total24h ?? 0) / 1e9).toFixed(2)}B  total7d=$${((dex.total7d ?? 0) / 1e9).toFixed(2)}B`);
  const topDex = (dex.protocols ?? [])
    .filter((p) => typeof p.total24h === "number")
    .sort((a, b) => b.total24h - a.total24h)
    .slice(0, 8)
    .map((p) => ({ name: p.name, chains: (p.chains ?? []).slice(0, 4), total24h: Math.round(p.total24h) }));
  for (const p of topDex) log(`    ${p.name.padEnd(16)} $${(p.total24h / 1e6).toFixed(1)}M/24h  chains=[${p.chains.join(",")}]`);

  // ---- 5. Stablecoin supply per chain (direct measure of parked dollars; no key) ----
  log("\n=== 5. stablecoins.llama.fi/stablecoinchains  (stablecoin $ supply per chain) ===");
  const stableRes = await getJSON("https://stablecoins.llama.fi/stablecoinchains");
  note(stableRes);
  const stable = stableRes.json as Array<{ name: string; totalCirculatingUSD?: Record<string, number> }>;
  const stableByChain = (stable ?? [])
    .map((c) => {
      const peg = c.totalCirculatingUSD ?? {};
      const usd = Object.values(peg).reduce((s, v) => s + (Number(v) || 0), 0);
      return { name: c.name, usd: Math.round(usd) };
    })
    .filter((c) => c.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 12);
  for (const c of stableByChain) log(`    ${c.name.padEnd(14)} $${(c.usd / 1e9).toFixed(2)}B stablecoins`);

  // ---- write POC artifacts ----
  const summary = {
    track: "OC3 DefiLlama chain/protocol rotation",
    generatedAt: new Date().toISOString(),
    source: "DefiLlama public REST (api.llama.fi / stablecoins.llama.fi) — NO API key",
    endpointsHit: rateLog.length,
    topChainsByTvl: top15,
    perChainHistory: Object.fromEntries(
      Object.entries(perChain).map(([k, v]) => [
        k,
        { firstDay: v.firstDay, lastDay: v.lastDay, nDays: v.nDays, lastTvl: v.lastTvl },
      ]),
    ),
    rotationShareTable: rotationRows,
    dexOverview: { total24h: dex.total24h, total7d: dex.total7d, topProtocols: topDex },
    stablecoinByChain: stableByChain,
    rateLog,
  };
  writeFileSync(resolve(OUT_DIR, "oc3-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    resolve(OUT_DIR, "oc3-chain-tvl-series.json"),
    JSON.stringify(
      { source: "DefiLlama /v2/historicalChainTvl (no key)", chains: perChain },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(OUT_DIR, "oc3-rotation-share.json"),
    JSON.stringify({ note: "chain share of total TVL across target basket", months: rotationRows }, null, 2),
  );

  log("\n=== WROTE ===");
  log(`  ${resolve(OUT_DIR, "oc3-summary.json")}`);
  log(`  ${resolve(OUT_DIR, "oc3-chain-tvl-series.json")}`);
  log(`  ${resolve(OUT_DIR, "oc3-rotation-share.json")}`);
  log(`  total endpoints hit (incl. rotation refetch): ${rateLog.length}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

export {};
