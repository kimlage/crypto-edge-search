/**
 * FRONT R2 — Illiquid / small-cap panel fetcher.
 *
 * Builds a DAILY close panel for a curated set of SMALLER-cap USDT pairs that are
 * liquid enough to trade TODAY but sit OUTSIDE the top-20 by market cap / volume —
 * the names where limits-to-arbitrage are highest and TA/reversal might survive.
 *
 * Selection rule (transparent):
 *   - Pull Binance 24h tickers, rank USDT spot pairs by quote volume.
 *   - EXCLUDE the top-20 by volume (the over-arbitraged majors) AND stablecoins.
 *   - From the remaining tier, KEEP names with:
 *       * 24h quote volume between $1.5M and $35M (liquid-enough, not a major),
 *       * at least MIN_DAYS of daily history (so the holdout is meaningful),
 *       * a recognizable established alt (not a 2024/2025 memecoin debut).
 *   - Target ~30-50 names.
 *
 * Cost realism: we ALSO snapshot 24h quote volume + an order-book depth probe so the
 * audit can charge a per-name spread/slippage cost as a function of thin depth.
 *
 * SURVIVORSHIP: the panel is only coins liquid on Binance TODAY. Dead/delisted
 * small-caps (a LARGE share of the small-cap graveyard) are absent, so any edge is a
 * strong UPPER BOUND. Stated loudly in meta + audit.
 *
 * Run: PATH=<codex-node-bin>:$PATH tsx scripts/r2-illiquid/fetch-smallcap-panel.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "output", "r2-illiquid");
mkdirSync(OUT_DIR, { recursive: true });

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const YEARS = 6;
const START_MS = NOW - YEARS * 365 * DAY_MS;
const MIN_DAYS = 1700; // require long history so the common-date intersection stays deep

// Curated candidate small/mid-cap tier: established alts OUTSIDE the top-20 by mkt
// cap, liquid on Binance, with multi-year history. Memecoins / 2024+ debuts excluded
// up-front because they lack the history a clean holdout needs. We over-request and
// then filter on actual fetched history length + today's volume.
const CANDIDATES = [
  // mid/small-cap L1s & infra outside top-20
  "ATOM", "ALGO", "ICP", "FIL", "HBAR", "EGLD", "EOS", "XTZ", "FLOW", "KAVA",
  "ZIL", "ONE", "IOTA", "WAVES", "QTUM", "ONT", "ICX", "ZEN", "DASH", "DCR",
  // DeFi / app tokens
  "AAVE", "UNI", "SUSHI", "CRV", "COMP", "MKR", "SNX", "YFI", "1INCH", "BAL",
  "ZRX", "KNC", "REN", "BAND", "RUNE", "INJ", "DYDX", "GMX", "PENDLE",
  // gaming / metaverse / NFT
  "SAND", "MANA", "AXS", "GALA", "ENJ", "CHZ", "APE", "GMT", "ILV",
  // data / oracle / storage / compute
  "GRT", "AR", "RENDER", "FET", "OCEAN", "STORJ", "ANKR", "NMR", "RLC",
  // older alts still liquid
  "XLM", "ETC", "NEO", "VET", "BAT", "LRC", "OMG", "DGB", "SC", "RVN",
  "CELO", "ROSE", "SKL", "AUDIO", "CTSI", "COTI", "LSK", "STMX",
  // misc liquid mid-caps
  "MASK", "API3", "SUPER", "MAGIC", "HIGH", "PEOPLE", "SSV", "JTO",
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetch24hTickers(): Promise<Map<string, number>> {
  const r = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`24hr http ${r.status}`);
  const all = (await r.json()) as { symbol: string; quoteVolume: string }[];
  const m = new Map<string, number>();
  for (const t of all) {
    if (t.symbol.endsWith("USDT")) {
      m.set(t.symbol.replace("USDT", ""), Number(t.quoteVolume));
    }
  }
  return m;
}

/** Order-book depth probe: sum of bid+ask notional within +/-50bps of mid. */
async function probeDepth(symbol: string): Promise<{ spreadBps: number; depthUsd50bps: number } | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}USDT&limit=100`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) return null;
    const b = (await r.json()) as { bids: [string, string][]; asks: [string, string][] };
    if (!b.bids?.length || !b.asks?.length) return null;
    const bestBid = Number(b.bids[0][0]);
    const bestAsk = Number(b.asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / mid) * 1e4;
    const lo = mid * (1 - 0.005);
    const hi = mid * (1 + 0.005);
    let depth = 0;
    for (const [p, q] of b.bids) {
      const price = Number(p);
      if (price >= lo) depth += price * Number(q);
    }
    for (const [p, q] of b.asks) {
      const price = Number(p);
      if (price <= hi) depth += price * Number(q);
    }
    return { spreadBps, depthUsd50bps: depth };
  } catch {
    return null;
  }
}

async function fetchBinanceDaily(symbol: string): Promise<[number, number][]> {
  const pair = `${symbol}USDT`;
  const rows: [number, number][] = [];
  let cursor = START_MS;
  for (let page = 0; page < 60; page += 1) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d` +
      `&startTime=${cursor}&limit=1000`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`network:${(err as Error)?.name ?? "err"}`);
    }
    if (!res.ok) throw new Error(`http:${res.status}`);
    const data = (await res.json()) as unknown[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const k of data as number[][]) {
      rows.push([Number(k[0]), Number(k[4])]);
    }
    const lastOpen = Number((data as number[][])[data.length - 1][0]);
    if (data.length < 1000) break;
    cursor = lastOpen + DAY_MS;
    if (cursor > NOW) break;
    await sleep(100);
  }
  return rows;
}

async function main(): Promise<void> {
  console.log("R2 small-cap panel fetch: ranking liquidity + pulling daily history...\n");
  const vol = await fetch24hTickers();

  // Rank ALL usdt pairs by volume to identify the top-20 majors to EXCLUDE.
  const ranked = [...vol.entries()].sort((a, b) => b[1] - a[1]);
  const top20 = new Set(ranked.slice(0, 20).map(([s]) => s));
  const STABLES = new Set(["USDC", "FDUSD", "TUSD", "DAI", "USD1", "RLUSD", "EUR", "XAUT", "PAXG"]);

  const kept: {
    symbol: string;
    dates: string[];
    closes: number[];
    quoteVol24h: number;
    spreadBps: number;
    depthUsd50bps: number;
  }[] = [];
  const rejected: { symbol: string; reason: string }[] = [];

  for (const sym of CANDIDATES) {
    if (top20.has(sym)) {
      rejected.push({ symbol: sym, reason: "in_top20_major" });
      continue;
    }
    if (STABLES.has(sym)) {
      rejected.push({ symbol: sym, reason: "stablecoin" });
      continue;
    }
    const qv = vol.get(sym) ?? 0;
    if (qv < 1.5e6) {
      rejected.push({ symbol: sym, reason: `low_vol_${(qv / 1e6).toFixed(2)}M` });
      continue;
    }
    if (qv > 35e6) {
      rejected.push({ symbol: sym, reason: `too_liquid_${(qv / 1e6).toFixed(1)}M` });
      continue;
    }
    let rows: [number, number][];
    try {
      rows = await fetchBinanceDaily(sym);
    } catch (e) {
      rejected.push({ symbol: sym, reason: `fetch_err_${(e as Error).message}` });
      continue;
    }
    if (rows.length < MIN_DAYS) {
      rejected.push({ symbol: sym, reason: `short_history_${rows.length}d` });
      continue;
    }
    const depth = await probeDepth(sym);
    const dates = rows.map(([t]) => new Date(t).toISOString().slice(0, 10));
    const closes = rows.map(([, c]) => c);
    kept.push({
      symbol: sym,
      dates,
      closes,
      quoteVol24h: qv,
      spreadBps: depth?.spreadBps ?? NaN,
      depthUsd50bps: depth?.depthUsd50bps ?? NaN,
    });
    console.log(
      `  + ${sym.padEnd(8)} ${rows.length}d  vol=$${(qv / 1e6).toFixed(1)}M  ` +
        `spread=${depth ? depth.spreadBps.toFixed(1) : "?"}bps  ` +
        `depth±50bps=$${depth ? (depth.depthUsd50bps / 1e3).toFixed(0) : "?"}k`,
    );
    await sleep(80);
  }

  // Use the UNION date axis (all dates any kept symbol has). Each symbol maps date->
  // close where present; absent => null. The cross-sectional ranker only ranks
  // symbols actually present on each date, so a deep axis is retained even though
  // younger names join late. This avoids collapsing to the youngest symbol's start.
  const allDates = [...new Set(kept.flatMap((k) => k.dates))].sort();
  // Require at least MIN_BREADTH symbols present on a date for it to be usable.
  const MIN_BREADTH = 10;
  const closeByDateRaw: Record<string, Record<string, number | null>> = {};
  for (const k of kept) {
    const map = new Map(k.dates.map((d, i) => [d, k.closes[i]]));
    closeByDateRaw[k.symbol] = {};
    for (const d of allDates) closeByDateRaw[k.symbol][d] = map.get(d) ?? null;
  }
  // Trim leading dates with thin breadth.
  const usableDates = allDates.filter((d) => {
    let n = 0;
    for (const k of kept) if (closeByDateRaw[k.symbol][d] != null) n += 1;
    return n >= MIN_BREADTH;
  });
  const commonDates = usableDates;
  const closeByDate: Record<string, Record<string, number | null>> = {};
  for (const k of kept) {
    closeByDate[k.symbol] = {};
    for (const d of commonDates) closeByDate[k.symbol][d] = closeByDateRaw[k.symbol][d];
  }

  const meta = {
    experiment: "r2-illiquid-smallcap",
    source: "binance",
    realData: true,
    generatedAt: new Date().toISOString(),
    universe: kept.map((k) => k.symbol),
    universeSize: kept.length,
    rejected,
    commonDates: commonDates.length,
    firstDate: commonDates[0],
    lastDate: commonDates.at(-1),
    minDaysRequired: MIN_DAYS,
    top20MajorsExcluded: [...top20],
    liquidity: kept.map((k) => ({
      symbol: k.symbol,
      quoteVol24hUsd: k.quoteVol24h,
      spreadBps: k.spreadBps,
      depthUsd50bps: k.depthUsd50bps,
    })),
    survivorshipNote:
      "Universe = SMALL/MID-cap coins liquid on Binance TODAY (ranks ~21-90 by volume). " +
      "The small-cap graveyard (dead/delisted alts) is ENTIRELY ABSENT — small-caps die at a " +
      "FAR higher rate than majors — so any measured edge is a STRONG UPPER BOUND. A marginal " +
      "pass MUST be treated as a fail.",
    costNote:
      "Per-name realistic cost = max(taker fee + half-spread + depth-driven slippage). " +
      "Small-caps get HIGHER cost than the majors' 4bps; see audit cost model.",
  };

  writeFileSync(join(OUT_DIR, "smallcap-meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(
    join(OUT_DIR, "smallcap-daily-closes.json"),
    JSON.stringify({ source: "binance", dates: commonDates, closes: closeByDate }),
  );

  console.log(
    `\nKept ${kept.length} small-caps; common dates=${commonDates.length} ` +
      `(${commonDates[0]}..${commonDates.at(-1)})`,
  );
  console.log(`Rejected ${rejected.length}. Wrote smallcap-meta.json + smallcap-daily-closes.json`);
}

main().catch((e) => {
  console.error("FETCH FAILED:", e);
  process.exit(1);
});
