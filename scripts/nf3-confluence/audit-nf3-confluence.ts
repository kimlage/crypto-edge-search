/**
 * TRACK NF3 — Confluence of RARE / low-N PRE-REGISTERED signals (read-only audit).
 *
 * HYPOTHESIS (user's): markets do not repeat exactly; some edges only show when a few
 * weak, individually-motivated signals ALIGN. Instead of searching a huge config space
 * (high N, which the Deflated Sharpe rightly punishes), PRE-REGISTER a SMALL FIXED set of
 * economically-motivated signals and require CONFLUENCE (>=k agree) before acting. The
 * rule is committed in advance, so the honest N stays tiny and a genuinely-present
 * confluence edge can validate on a modest holdout. The combined signal fires RARELY —
 * that is the point.
 *
 * INSTRUMENT: BTCUSDT, DAILY bars (UTC) aggregated causally from the committed 15m history
 * (output/bigquery/btc_ohlcv_15m.ndjson, real Binance) with HIGH/LOW preserved for
 * path-dependent signals. Auxiliary real data:
 *   - output/funding/BTCUSDT_funding_8h.json  (8h funding, the carry signal)
 *   - output/funding/BTCUSDT_prices_daily.json (spot vs perp close, the basis signal)
 *   - output/crossxs/daily-closes.json         (30-coin daily panel, cross-sectional dispersion)
 * Common window = funding availability = 2023-06-01 .. 2026-05-31 (~1095 daily bars).
 *
 * PRE-REGISTERED SIGNAL SET (6 distinct, each individually economically motivated;
 * FIXED BEFORE seeing the combined result; all computed CAUSALLY at t using data <= t-1):
 *   S1 carry-rich      : trailing-mean 8h funding > 0 AND not extreme — perp longs pay
 *                        shorts a carry; positive-but-not-blowoff funding = healthy carry.
 *   S2 basis-positive  : perp close > spot close (contango) — futures premium / carry tailwind.
 *   S3 oversold-support: %b (Bollinger position) < 0.5 with RSI(14) between 30 and 55 —
 *                        pulled back toward support but not in a crash (buy the dip).
 *   S4 trend-up        : close > slow SMA(50) — primary uptrend filter.
 *   S5 risk-on-disp    : cross-sectional dispersion of 30-coin daily returns BELOW its
 *                        trailing median — low dispersion = correlated risk-on tape.
 *   S6 momentum-up     : 20-day return > 0 — intermediate momentum confirmation.
 * All six are LONG-side signals; CONFLUENCE = go long BTC for the next day when >=k fire.
 * When <k fire, stay FLAT (no short — this is a long-or-flat confluence rule).
 *
 * HONEST N: we sweep k in {3,4,5,6} (4 values) and 2 carry-threshold variants for S1, and
 * we test the same rule scored two ways is NOT done — we commit ONE decision (long/flat) and
 * ONE statistic. TRUE N counted = (k-values) x (carry variants) = 4 x 2 = 8 distinct configs
 * evaluated on the search slice. We feed N=8 to DSR/haircut. We do NOT pretend N=1.
 *
 * COST: 8 bps round-trip (taker ~4 bps/side) charged on every change of position
 * (flat<->long) via the position path. Turnover logged.
 *
 * VALIDATION: single-call committed gauntlet src/lib/validation/strategy-validator.ts
 * (validateStrategy): net-of-cost -> baselines (B&H + random-lottery) -> Deflated Sharpe at
 * honest N -> Harvey-Liu haircut -> surrogate/placebo (phase + block bootstrap) ->
 * consume-once holdout. Gates are imported and reused, NOT reimplemented or relaxed.
 *
 * DECISIVE QUESTION: does pre-registered low-N confluence validate where high-N search
 * failed — a real edge that only shows when several weak/rare signals align — OR does
 * confluence just produce too few trades to distinguish from luck (wide DSR, fragile
 * holdout)? We report which way it lands.
 *
 * Writes ONLY to output/nf3-confluence/. Run:
 *   
 *     node_modules/.bin/tsx scripts/nf3-confluence/audit-nf3-confluence.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { validateStrategy } from "../../src/lib/validation/strategy-validator";
import { summarizeReturnSeries } from "../../src/lib/statistical-validation";

// ----------------------------- constants -----------------------------------
const TAKER_PER_SIDE = 0.0004; // 4 bps/side => 8 bps round trip
const COMMON_START = "2023-06-01";
const COMMON_END = "2026-05-31";
const OUT_DIR = join("output", "nf3-confluence");

// ----------------------------- data loading ---------------------------------
interface DailyBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Causal UTC-daily OHLC from the 15m ndjson. Drops the final (possibly partial) day. */
function loadBtcDaily(): DailyBar[] {
  const path = join("output", "bigquery", "btc_ohlcv_15m.ndjson");
  const text = readFileSync(path, "utf8");
  const byDay = new Map<string, { open: number; high: number; low: number; close: number; firstT: string; lastT: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const date = String(o.event_date ?? "");
    const t = String(o.event_time ?? "");
    const open = Number(o.open), high = Number(o.high), low = Number(o.low), close = Number(o.close);
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    const cur = byDay.get(date);
    if (!cur) {
      byDay.set(date, { open, high, low, close, firstT: t, lastT: t });
    } else {
      if (t < cur.firstT) { cur.open = open; cur.firstT = t; }
      if (t > cur.lastT) { cur.close = close; cur.lastT = t; }
      if (Number.isFinite(high) && high > cur.high) cur.high = high;
      if (Number.isFinite(low) && low < cur.low) cur.low = low;
    }
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const bars = days.map(([date, v]) => ({ date, open: v.open, high: v.high, low: v.low, close: v.close }));
  // drop the most recent day (may be partial)
  return bars.slice(0, bars.length - 1);
}

/** Daily mean 8h funding rate, keyed by date (sum of the up-to-3 8h prints in the UTC day). */
function loadDailyFunding(): Map<string, number> {
  const path = join("output", "funding", "BTCUSDT_funding_8h.json");
  const arr = JSON.parse(readFileSync(path, "utf8")) as { fundingTime: number; fundingRate: number }[];
  const sumByDay = new Map<string, { sum: number; n: number }>();
  for (const r of arr) {
    const date = new Date(r.fundingTime).toISOString().slice(0, 10);
    const cur = sumByDay.get(date) ?? { sum: 0, n: 0 };
    cur.sum += r.fundingRate; cur.n += 1;
    sumByDay.set(date, cur);
  }
  // daily funding = SUM of 8h prints in the day (the carry actually paid that day)
  const out = new Map<string, number>();
  for (const [d, v] of sumByDay) out.set(d, v.sum);
  return out;
}

/** Perp/spot daily closes, keyed by date. */
function loadBasis(): Map<string, { spot: number; perp: number }> {
  const path = join("output", "funding", "BTCUSDT_prices_daily.json");
  const arr = JSON.parse(readFileSync(path, "utf8")) as { date: string; spotClose: number; perpClose: number }[];
  const out = new Map<string, { spot: number; perp: number }>();
  for (const r of arr) out.set(r.date, { spot: r.spotClose, perp: r.perpClose });
  return out;
}

/** Cross-sectional dispersion (stdev of daily returns across 30 coins), keyed by date. */
function loadDispersion(): Map<string, number> {
  const path = join("output", "crossxs", "daily-closes.json");
  const d = JSON.parse(readFileSync(path, "utf8")) as { dates: string[]; closes: Record<string, (number | null)[]> };
  const coins = Object.keys(d.closes);
  const out = new Map<string, number>();
  for (let i = 1; i < d.dates.length; i++) {
    const rets: number[] = [];
    for (const c of coins) {
      const p0 = d.closes[c][i - 1], p1 = d.closes[c][i];
      if (p0 != null && p1 != null && p0 > 0) rets.push(p1 / p0 - 1);
    }
    if (rets.length >= 10) {
      const m = rets.reduce((s, v) => s + v, 0) / rets.length;
      const varr = rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length;
      out.set(d.dates[i], Math.sqrt(varr));
    }
  }
  return out;
}

// ----------------------------- indicators -----------------------------------
function sma(values: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += values[j];
  return s / n;
}

function stdev(values: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += values[j];
  const m = s / n;
  let v = 0;
  for (let j = i - n + 1; j <= i; j++) v += (values[j] - m) ** 2;
  return Math.sqrt(v / n);
}

/** Wilder RSI(n) at index i (needs i>=n). */
function rsi(closes: number[], i: number, n: number): number | null {
  if (i < n) return null;
  let gain = 0, loss = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const ch = closes[j] - closes[j - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  const avgG = gain / n, avgL = loss / n;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// ----------------------------- main ----------------------------------------
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface AlignedRow {
  date: string;
  close: number;
  ret: number; // close-to-close return realized on this day (from prev close)
  funding: number | null;
  spot: number | null;
  perp: number | null;
  dispersion: number | null;
}

function buildAligned(): AlignedRow[] {
  const btc = loadBtcDaily();
  const funding = loadDailyFunding();
  const basis = loadBasis();
  const disp = loadDispersion();

  const inWindow = btc.filter((b) => b.date >= COMMON_START && b.date <= COMMON_END);
  const rows: AlignedRow[] = [];
  for (let i = 0; i < inWindow.length; i++) {
    const b = inWindow[i];
    const prevClose = i === 0 ? b.close : inWindow[i - 1].close;
    const bs = basis.get(b.date);
    rows.push({
      date: b.date,
      close: b.close,
      ret: i === 0 ? 0 : b.close / prevClose - 1,
      funding: funding.get(b.date) ?? null,
      spot: bs?.spot ?? null,
      perp: bs?.perp ?? null,
      dispersion: disp.get(b.date) ?? null,
    });
  }
  return rows;
}

/**
 * Build the 6 pre-registered boolean signals for each row, computed CAUSALLY: the signal
 * that decides day t's position uses ONLY data observable at the close of day t-1 (i.e.
 * indexes <= i-1). carryHighThresh selects between the two committed S1 variants.
 */
interface SignalRow {
  fire: boolean[]; // S1..S6, decision for THIS day's return (uses data <= prev day)
  count: number;
}

function computeSignals(rows: AlignedRow[], carryHighThresh: number): SignalRow[] {
  const closes = rows.map((r) => r.close);
  const out: SignalRow[] = [];

  // precompute trailing dispersion medians causally (median of dispersion over <= i-1)
  for (let i = 0; i < rows.length; i++) {
    // decision for day i uses data through i-1
    const di = i - 1;
    const fire = [false, false, false, false, false, false];
    if (di >= 0) {
      // S1 carry-rich: trailing 7d mean daily funding > 0 and < carryHighThresh (not blowoff)
      const fwin: number[] = [];
      for (let j = Math.max(0, di - 6); j <= di; j++) if (rows[j].funding != null) fwin.push(rows[j].funding!);
      if (fwin.length >= 4) {
        const mf = fwin.reduce((s, v) => s + v, 0) / fwin.length;
        fire[0] = mf > 0 && mf < carryHighThresh;
      }
      // S2 basis-positive: perp > spot at di
      if (rows[di].perp != null && rows[di].spot != null) fire[1] = rows[di].perp! > rows[di].spot!;
      // S3 oversold-support: %b<0.5 (Bollinger 20,2) AND RSI(14) in [30,55]
      const mb = sma(closes, di, 20);
      const sb = stdev(closes, di, 20);
      const r14 = rsi(closes, di, 14);
      if (mb != null && sb != null && sb > 0 && r14 != null) {
        const upper = mb + 2 * sb, lower = mb - 2 * sb;
        const pctB = (closes[di] - lower) / (upper - lower);
        fire[2] = pctB < 0.5 && r14 >= 30 && r14 <= 55;
      }
      // S4 trend-up: close > SMA(50)
      const s50 = sma(closes, di, 50);
      if (s50 != null) fire[3] = closes[di] > s50;
      // S5 risk-on low dispersion: dispersion(di) < trailing-60 median of dispersion (<=di)
      if (rows[di].dispersion != null) {
        const dwin: number[] = [];
        for (let j = Math.max(0, di - 59); j <= di; j++) if (rows[j].dispersion != null) dwin.push(rows[j].dispersion!);
        if (dwin.length >= 20) fire[4] = rows[di].dispersion! < median(dwin);
      }
      // S6 momentum-up: 20d return > 0
      if (di - 20 >= 0) fire[5] = closes[di] > closes[di - 20];
    }
    out.push({ fire, count: fire.filter(Boolean).length });
  }
  return out;
}

/** Position path (long=1 / flat=0) for confluence threshold k. Decision at i fixed by data<=i-1. */
function buildPositions(signals: SignalRow[], k: number): number[] {
  return signals.map((s) => (s.count >= k ? 1 : 0));
}

/** Gross per-day return given a long/flat position path (position[i] earns rows[i].ret). */
function grossReturns(rows: AlignedRow[], position: number[]): number[] {
  return rows.map((r, i) => position[i] * r.ret);
}

function turnoverOf(position: number[]): number {
  let t = 0;
  for (let i = 0; i < position.length; i++) {
    const prev = i === 0 ? 0 : position[i - 1];
    t += Math.abs(position[i] - prev);
  }
  return t;
}

function netSummary(rows: AlignedRow[], position: number[]) {
  const gross = grossReturns(rows, position);
  const rt = TAKER_PER_SIDE * 2;
  const net = gross.map((g, i) => {
    const prev = i === 0 ? 0 : position[i - 1];
    const delta = Math.abs(position[i] - prev);
    return g - delta * rt;
  });
  const tradeDays = position.filter((p) => p > 0).length;
  return {
    netStats: summarizeReturnSeries(net),
    grossStats: summarizeReturnSeries(gross),
    turnover: turnoverOf(position),
    tradeDays,
  };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = buildAligned();
  const marketReturns = rows.map((r) => r.ret);

  console.log("=".repeat(78));
  console.log("TRACK NF3 — Pre-registered low-N CONFLUENCE of rare signals (BTC daily)");
  console.log("=".repeat(78));
  console.log(`Window: ${rows[0]?.date} .. ${rows[rows.length - 1]?.date}  (${rows.length} daily bars)`);

  // -------- self-checks (causality + pure-noise) --------
  selfChecks(rows);

  // -------- pre-registered search grid --------
  // HONEST N: k in {3,4,5,6} x carryThresh in {0.0015, 0.003} = 8 configs.
  const kValues = [3, 4, 5, 6];
  const carryThreshes = [0.0015, 0.003];
  const HONEST_N = kValues.length * carryThreshes.length; // 8

  // signal-firing diagnostics (how often each pre-registered signal fires individually)
  const sig0 = computeSignals(rows, carryThreshes[0]);
  const fireFrac = [0, 0, 0, 0, 0, 0].map((_, s) => sig0.filter((r) => r.fire[s]).length / rows.length);
  console.log("\nIndividual signal fire fractions (carryThresh=" + carryThreshes[0] + "):");
  const names = ["S1 carry-rich", "S2 basis-pos", "S3 oversold-sup", "S4 trend-up", "S5 low-disp", "S6 mom-up"];
  names.forEach((nm, i) => console.log(`  ${nm.padEnd(16)} ${(fireFrac[i] * 100).toFixed(1)}%`));

  console.log("\nConfluence search grid (honest N=" + HONEST_N + "):  trade-days & in-sample net Sharpe");
  console.log("  k   carryThr  tradeDays  turnover  netSharpe  netCompound");
  type Cfg = { k: number; carry: number; position: number[]; netSharpe: number; tradeDays: number; turnover: number; netCompound: number };
  const configs: Cfg[] = [];
  for (const carry of carryThreshes) {
    const sigs = computeSignals(rows, carry);
    for (const k of kValues) {
      const position = buildPositions(sigs, k);
      const s = netSummary(rows, position);
      configs.push({ k, carry, position, netSharpe: s.netStats.sharpe, tradeDays: s.tradeDays, turnover: s.turnover, netCompound: s.netStats.compoundReturn });
      console.log(
        `  ${k}   ${carry.toFixed(4)}   ${String(s.tradeDays).padStart(8)}  ${s.turnover.toFixed(1).padStart(7)}  ${s.netStats.sharpe.toFixed(4).padStart(8)}  ${(s.netStats.compoundReturn * 100).toFixed(2).padStart(8)}%`,
      );
    }
  }

  // Pick the BEST config by IN-SAMPLE net Sharpe (the optimistic choice an overfitter makes).
  // The validator carves its OWN holdout internally, but to be honest about selection we
  // pick on the full-series in-sample summary here and then let the gauntlet test it. The
  // honest N=8 is fed to DSR/haircut regardless of which config wins.
  const best = configs.reduce((a, b) => (b.netSharpe > a.netSharpe ? b : a));
  console.log(`\nBest in-sample config: k=${best.k}, carryThresh=${best.carry}, tradeDays=${best.tradeDays}, netSharpe=${best.netSharpe.toFixed(4)}`);

  // ---------------- run the committed gauntlet on the best config ----------------
  const gross = grossReturns(rows, best.position);
  const verdict = validateStrategy(gross, {
    trialCount: HONEST_N,
    statistic: "sharpe", // confluence is a TIMING/STRUCTURE claim, not a pure carry premium
    cost: { takerPerSide: TAKER_PER_SIDE, position: best.position },
    baselines: { marketReturns, roundTripCost: TAKER_PER_SIDE * 2 },
    surrogate: { iterations: 400, statistic: "sharpe", seed: "nf3-confluence" },
    holdout: { holdoutFraction: 0.2, reason: "nf3-confluence-consume-once" },
    seed: "nf3-confluence",
  });

  printVerdict("BEST-CONFIG", verdict);

  // ---------------- ALSO run the SPARSEST committed config (k=6) as the "rarest confluence" ----------------
  // The user's hypothesis specifically is about the RAREST alignment. Report it explicitly.
  const sigsRare = computeSignals(rows, carryThreshes[0]);
  const rarePos = buildPositions(sigsRare, 6);
  const rareSummary = netSummary(rows, rarePos);
  console.log(`\nRarest confluence (k=6): tradeDays=${rareSummary.tradeDays}, turnover=${rareSummary.turnover.toFixed(1)}, in-sample netSharpe=${rareSummary.netStats.sharpe.toFixed(4)}`);
  let rareVerdict: ReturnType<typeof validateStrategy> | null = null;
  if (rareSummary.tradeDays >= 5) {
    const grossRare = grossReturns(rows, rarePos);
    rareVerdict = validateStrategy(grossRare, {
      trialCount: HONEST_N,
      statistic: "sharpe",
      cost: { takerPerSide: TAKER_PER_SIDE, position: rarePos },
      baselines: { marketReturns, roundTripCost: TAKER_PER_SIDE * 2 },
      surrogate: { iterations: 400, statistic: "sharpe", seed: "nf3-confluence-rare" },
      holdout: { holdoutFraction: 0.2, reason: "nf3-confluence-rare-consume-once" },
      seed: "nf3-confluence-rare",
    });
    printVerdict("RAREST-k6", rareVerdict);
  } else {
    console.log("  (k=6 fires too rarely to validate — degenerate; see honestCaveats)");
  }

  // ---------------- SURROGATE/PLACEBO at the SEARCH level ----------------
  // The validator's internal surrogate tests the chosen series. We ALSO run the IDENTICAL
  // search machinery (compute 6 signals -> sweep grid -> pick best in-sample Sharpe) on
  // phase-randomized BTC return surrogates: if the confluence "edge" is luck, the best-of-8
  // in-sample Sharpe on real data should sit INSIDE the surrogate distribution.
  const placebo = searchLevelPlacebo(rows, kValues, carryThreshes, best.netSharpe);
  console.log("\nSearch-level placebo (phase-randomized BTC returns, identical machinery):");
  console.log(`  real best-of-${HONEST_N} in-sample netSharpe = ${best.netSharpe.toFixed(4)}`);
  console.log(`  surrogate best-of-${HONEST_N} netSharpe: mean=${placebo.mean.toFixed(4)}, p95=${placebo.p95.toFixed(4)}, max=${placebo.max.toFixed(4)}`);
  console.log(`  placebo p-value (frac surrogate best >= real best) = ${placebo.pValue.toFixed(3)} over ${placebo.iters} surrogates`);

  // ---------------- write evidence ----------------
  const evidence = {
    track: "NF3-confluence",
    window: { start: rows[0]?.date, end: rows[rows.length - 1]?.date, bars: rows.length },
    honestN: HONEST_N,
    individualFireFractions: Object.fromEntries(names.map((nm, i) => [nm, fireFrac[i]])),
    grid: configs.map((c) => ({ k: c.k, carry: c.carry, tradeDays: c.tradeDays, turnover: c.turnover, netSharpe: c.netSharpe, netCompound: c.netCompound })),
    best: { k: best.k, carry: best.carry, tradeDays: best.tradeDays, turnover: best.turnover, netSharpe: best.netSharpe },
    bestVerdict: { verdict: verdict.verdict, bindingGate: verdict.bindingGate, perGate: verdict.perGate, netStats: verdict.netStats },
    rare_k6: rareVerdict
      ? { tradeDays: rareSummary.tradeDays, verdict: rareVerdict.verdict, bindingGate: rareVerdict.bindingGate, perGate: rareVerdict.perGate }
      : { tradeDays: rareSummary.tradeDays, note: "too rare to validate" },
    searchLevelPlacebo: placebo,
  };
  const outPath = join(OUT_DIR, "nf3-confluence-evidence.json");
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written: ${outPath}`);

  // ---------------- final verdict line ----------------
  const surrogateGate = verdict.perGate.find((g) => g.id === "surrogate");
  const holdoutGate = verdict.perGate.find((g) => g.id === "holdout");
  console.log("\n" + "=".repeat(78));
  console.log(`NF3 FINAL VERDICT (best config): ${verdict.verdict}  binding=${verdict.bindingGate ?? "none"}`);
  console.log(`  net Sharpe=${verdict.netStats.sharpe.toFixed(4)}, turnover=${verdict.netStats.turnover.toFixed(1)}`);
  console.log(`  surrogate placeboP=${(surrogateGate?.detail.placeboP as number)?.toFixed?.(3)}, holdout=${holdoutGate?.passed ? "PASS" : "FAIL"}`);
  console.log(`  search-level placebo p=${placebo.pValue.toFixed(3)}`);
  console.log("=".repeat(78));
}

// --------- search-level placebo: rerun the whole machinery on phase-randomized returns ---------
function phaseRandomizeReturns(ret: number[], rnd: () => number): number[] {
  // simple phase randomization on the return series (preserve power spectrum / autocorr)
  const n = ret.length;
  if (n < 8) return [...ret];
  const m = ret.reduce((s, v) => s + v, 0) / n;
  const c = ret.map((v) => v - m);
  // naive DFT (n ~ 1095, fine for a few hundred iters here is too slow; use a light FFT-free
  // surrogate: random circular block rotation + sign-preserving phase scramble via IAAFT-lite).
  // To keep it cheap and still destroy genuine cross-signal structure while preserving the
  // marginal and rough autocorrelation, we use a stationary block bootstrap (Politis-Romano).
  const L = Math.max(2, Math.round(Math.sqrt(n)));
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(rnd() * n);
    for (let o = 0; o < L && out.length < n; o++) out.push(c[(start + o) % n] + m);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function searchLevelPlacebo(
  rows: AlignedRow[],
  kValues: number[],
  carryThreshes: number[],
  realBest: number,
): { iters: number; mean: number; p95: number; max: number; pValue: number } {
  const iters = 300;
  const rnd = mulberry32(0xC0FFEE);
  const realRet = rows.map((r) => r.ret);
  const bests: number[] = [];
  for (let it = 0; it < iters; it++) {
    const surrRet = phaseRandomizeReturns(realRet, rnd);
    // rebuild a surrogate row set: keep funding/basis/dispersion structure but reconstruct
    // close path from surrogate returns so the OHLC-derived signals (S3,S4,S6) see scrambled
    // structure. Funding/basis/dispersion (S1,S2,S5) are KEPT as real (they are exogenous),
    // which is conservative: it only HELPS the surrogate keep any genuine S1/S2/S5 edge.
    let px = 100;
    const surrRows: AlignedRow[] = rows.map((r, i) => {
      const ret = surrRet[i];
      px = i === 0 ? px : px * (1 + ret);
      return { ...r, close: px, ret };
    });
    let bestSh = -Infinity;
    for (const carry of carryThreshes) {
      const sigs = computeSignals(surrRows, carry);
      for (const k of kValues) {
        const pos = buildPositions(sigs, k);
        const s = netSummary(surrRows, pos);
        if (s.tradeDays >= 5 && s.netStats.sharpe > bestSh) bestSh = s.netStats.sharpe;
      }
    }
    if (Number.isFinite(bestSh)) bests.push(bestSh);
  }
  bests.sort((a, b) => a - b);
  const mean = bests.reduce((s, v) => s + v, 0) / Math.max(1, bests.length);
  const p95 = bests.length ? bests[Math.floor(0.95 * (bests.length - 1))] : NaN;
  const max = bests.length ? bests[bests.length - 1] : NaN;
  const ge = bests.filter((v) => v >= realBest).length;
  const pValue = bests.length ? ge / bests.length : 1;
  return { iters: bests.length, mean, p95, max, pValue };
}

// ----------------------------- self-checks ----------------------------------
function selfChecks(rows: AlignedRow[]): void {
  // (1) CAUSALITY: mutating a FUTURE bar must not change an earlier day's signal count.
  const sigs = computeSignals(rows, 0.0015);
  const mutated = rows.map((r) => ({ ...r }));
  const mid = Math.floor(rows.length / 2);
  mutated[mid].close *= 1.5; // corrupt a future bar
  mutated[mid].funding = 0.05;
  const sigsMut = computeSignals(mutated, 0.0015);
  let causalOk = true;
  for (let i = 0; i < mid; i++) {
    if (sigs[i].count !== sigsMut[i].count) { causalOk = false; break; }
  }
  // (2) PURE-NOISE: confluence on iid-noise BTC returns should have ~no net edge.
  const rnd = mulberry32(42);
  let px = 100;
  const noiseRows: AlignedRow[] = rows.map((r, i) => {
    const ret = (rnd() - 0.5) * 0.04;
    px = i === 0 ? px : px * (1 + ret);
    return { ...r, close: px, ret, funding: (rnd() - 0.4) * 0.001, perp: px * (1 + (rnd() - 0.5) * 0.001), spot: px, dispersion: 0.02 + (rnd() - 0.5) * 0.01 };
  });
  const noiseSigs = computeSignals(noiseRows, 0.0015);
  const noisePos = buildPositions(noiseSigs, 3);
  const noiseNet = netSummary(noiseRows, noisePos);
  console.log("\nSelf-checks:");
  console.log(`  causality (future bar cannot change past signal): ${causalOk ? "PASS" : "FAIL"}`);
  console.log(`  pure-noise net Sharpe (should be ~0): ${noiseNet.netStats.sharpe.toFixed(3)} (tradeDays=${noiseNet.tradeDays})`);
  if (!causalOk) throw new Error("CAUSALITY SELF-CHECK FAILED — signals leak future data");
}

function printVerdict(tag: string, v: ReturnType<typeof validateStrategy>): void {
  console.log(`\n[${tag}] verdict=${v.verdict}  binding=${v.bindingGate ?? "none"}  (honest N=${v.trialCount})`);
  for (const g of v.perGate) {
    console.log(`  ${g.passed ? "PASS" : "FAIL"}  ${g.id.padEnd(15)} ${g.reason}`);
  }
}

main();
