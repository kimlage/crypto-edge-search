/**
 * TRACK OC3 — PRELIMINARY, DESCRIPTIVE signal check (NOT a full edge test).
 *
 * Hypothesis (the on-chain analog of cross-tier rotation): a chain that is
 * GAINING TVL share (capital rotating INTO its ecosystem) tends to see its
 * native token outperform over the following month — and vice versa.
 *
 * Method (all $0, DefiLlama no-key):
 *   - chain monthly TVL share  (from /v2/historicalChainTvl/{chain})
 *   - chain native-token monthly price (from coins.llama.fi/chart, no key)
 *   - signal_t  = 3-month change in TVL share (momentum of capital rotation)
 *   - target_t  = next-month native-token return
 *   - report pooled Spearman-ish rank correlation + quintile spread.
 *
 * This is intentionally crude (small chain set, monthly grid, no costs/embargo).
 * It exists only to answer: "does any fetched on-chain series move WITH forward
 * returns at all?" — an honest preliminary read, not a tradable result.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-scout/oc3-signal-check.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT_DIR = resolve(ROOT, "output/onchain-scout/oc3-defillama");
mkdirSync(OUT_DIR, { recursive: true });
const log = (...a: unknown[]) => console.log(...a);

// chain -> defillama coins id for the native token
const CHAINS: Record<string, string> = {
  Ethereum: "coingecko:ethereum",
  Solana: "coingecko:solana",
  BSC: "coingecko:binancecoin",
  Avalanche: "coingecko:avalanche-2",
  Polygon: "coingecko:matic-network",
  Tron: "coingecko:tron",
};

async function getJSON(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const monthKey = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Pearson on ranks (Spearman). Returns rho.
function spearman(x: number[], y: number[]): number {
  const rank = (a: number[]) => {
    const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length).fill(0);
    for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const rx = rank(x);
  const ry = rank(y);
  const n = x.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

async function main() {
  // 1. monthly TVL per chain
  const tvlByChainMonth: Record<string, Map<string, number>> = {};
  for (const chain of Object.keys(CHAINS)) {
    const series: Array<{ date: number; tvl: number }> = await getJSON(
      `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`,
    );
    const m = new Map<string, number>();
    for (const p of series) m.set(monthKey(p.date), p.tvl); // last obs in month
    tvlByChainMonth[chain] = m;
  }

  // 2. monthly native price per chain (last price in month).
  // coins.llama.fi/chart caps span at ~500 daily points, so page in chunks.
  const priceByChainMonth: Record<string, Map<string, number>> = {};
  const DAY = 86_400;
  const SPAN = 400; // <500 cap
  const start = Math.floor(Date.parse("2021-01-01T00:00:00Z") / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [chain, coinId] of Object.entries(CHAINS)) {
    const m = new Map<string, number>();
    for (let s = start; s < nowSec; s += SPAN * DAY) {
      const data = await getJSON(
        `https://coins.llama.fi/chart/${coinId}?start=${s}&span=${SPAN}&period=1d`,
      );
      const prices: Array<{ timestamp: number; price: number }> =
        data?.coins?.[coinId]?.prices ?? [];
      for (const p of prices) m.set(monthKey(p.timestamp), p.price);
    }
    priceByChainMonth[chain] = m;
    log(`  price ${chain.padEnd(10)} months=${m.size}`);
  }

  // 3. common month grid
  const months = Array.from(
    new Set(Object.values(tvlByChainMonth).flatMap((m) => Array.from(m.keys()))),
  )
    .filter((mo) => mo >= "2021-03") // after enough chains exist
    .sort();

  // 4. build pooled (signal, forward-return) pairs
  const LOOKBACK = 3; // months of TVL-share change
  const pairs: Array<{ month: string; chain: string; shareMom: number; fwdRet: number }> = [];
  for (let i = LOOKBACK; i < months.length - 1; i++) {
    const moNow = months[i];
    const moPrev = months[i - LOOKBACK];
    const moNext = months[i + 1];

    // total TVL this month and lookback month across chains
    let totNow = 0,
      totPrev = 0;
    for (const c of Object.keys(CHAINS)) {
      totNow += tvlByChainMonth[c].get(moNow) ?? 0;
      totPrev += tvlByChainMonth[c].get(moPrev) ?? 0;
    }
    if (totNow <= 0 || totPrev <= 0) continue;

    for (const c of Object.keys(CHAINS)) {
      const shareNow = (tvlByChainMonth[c].get(moNow) ?? 0) / totNow;
      const sharePrev = (tvlByChainMonth[c].get(moPrev) ?? 0) / totPrev;
      const pNow = priceByChainMonth[c].get(moNow);
      const pNext = priceByChainMonth[c].get(moNext);
      if (!pNow || !pNext || sharePrev <= 0) continue;
      const shareMom = shareNow - sharePrev; // delta in share (rotation INTO chain)
      const fwdRet = pNext / pNow - 1;
      pairs.push({ month: moNow, chain: c, shareMom, fwdRet });
    }
  }

  log(`Pooled cross-chain observations: ${pairs.length} (months ${months[LOOKBACK]}..${months[months.length - 2]})`);

  // 5. pooled Spearman of share-momentum vs forward return
  const rho = spearman(
    pairs.map((p) => p.shareMom),
    pairs.map((p) => p.fwdRet),
  );

  // 6. quintile spread (top vs bottom share-momentum)
  const sorted = [...pairs].sort((a, b) => a.shareMom - b.shareMom);
  const q = Math.max(1, Math.floor(sorted.length / 5));
  const bottom = sorted.slice(0, q);
  const top = sorted.slice(sorted.length - q);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const topRet = mean(top.map((p) => p.fwdRet));
  const botRet = mean(bottom.map((p) => p.fwdRet));

  log(`\nPRELIMINARY SIGNAL (descriptive, NOT an edge test):`);
  log(`  Spearman rho(3m TVL-share change, next-month native return) = ${rho.toFixed(3)}`);
  log(`  Top-quintile (capital rotating IN)  next-month mean return = ${(topRet * 100).toFixed(1)}%  (n=${top.length})`);
  log(`  Bot-quintile (capital rotating OUT) next-month mean return = ${(botRet * 100).toFixed(1)}%  (n=${bottom.length})`);
  log(`  Long-IN / short-OUT monthly spread = ${((topRet - botRet) * 100).toFixed(1)} pp`);

  const result = {
    track: "OC3 preliminary signal check (descriptive)",
    generatedAt: new Date().toISOString(),
    source: "DefiLlama no-key: /v2/historicalChainTvl + coins.llama.fi/chart",
    chains: Object.keys(CHAINS),
    nObservations: pairs.length,
    lookbackMonths: LOOKBACK,
    spearmanRho: Number(rho.toFixed(4)),
    topQuintileFwdRet: Number(topRet.toFixed(4)),
    bottomQuintileFwdRet: Number(botRet.toFixed(4)),
    longShortSpreadPP: Number(((topRet - botRet) * 100).toFixed(2)),
    caveat:
      "Crude: 6 chains, monthly grid, no fees/embargo/multiple-testing control. Directional read only.",
  };
  writeFileSync(resolve(OUT_DIR, "oc3-signal-check.json"), JSON.stringify(result, null, 2));
  log(`\nWROTE ${resolve(OUT_DIR, "oc3-signal-check.json")}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

export {};
