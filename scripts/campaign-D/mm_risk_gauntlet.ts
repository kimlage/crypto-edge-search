/**
 * Campaign-D / PM-money-management — can ANY portfolio/risk scheme turn the edge into profit?
 *
 * Decisive principle being tested: a staking/risk rule changes the VARIANCE and the PATH of a bet
 * stream, never the SIGN of its expectancy. With a per-bet edge E[r] <= 0, no sizing scheme produces
 * positive expected log-growth. We test this EMPIRICALLY on the real ≤0-edge streams from the proof
 * phase, across the full suite of money-management + risk strategies, with a synthetic POSITIVE-edge
 * control to prove the harness would detect profit if it existed.
 *
 * Bet model (standard betting-growth): bankroll B *= (1 + f_i * r_i), where r_i = (outcome - c_i)/c_i
 * for a $1-staked binary bet at effective cost c_i (win => (1-c)/c, lose => -1), and f_i is the
 * fraction of bankroll the scheme allocates. Monte-Carlo over bet-order permutations.
 *
 * Run: npx tsx scripts/campaign-D/mm_risk_gauntlet.ts
 */
import { readFileSync } from "node:fs";

const H = 0.01;          // half-spread
const B0 = 1000;         // starting bankroll
const PERM = 1500;       // Monte-Carlo permutations
const RUIN = 0.01 * B0;  // ruin threshold

type Bet = { c: number; win: number; q: number }; // effective cost, realized win 0/1, est win-prob (for Kelly)
const rWin = (c: number) => (1 - c) / c, rLose = -1;

// ---- build real bet streams from the calibration corpus ----
type Row = { resYes: number; p_24h: number | null };
const rows: Row[] = readFileSync("output/campaign-D/calibration.jsonl", "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const data = rows.filter((r) => r.p_24h != null && r.p_24h > 0.005 && r.p_24h < 0.995);

// empirical calibration map (bucketed) for an "informed" Kelly q
function empBucketRate(): (p: number) => number {
  const edges = [0, .02, .05, .1, .15, .2, .3, .4, .5, .6, .7, .8, .9, .95, 1.01];
  const cnt = edges.slice(0, -1).map(() => ({ n: 0, y: 0 }));
  for (const r of data) { const i = edges.findIndex((e, k) => r.p_24h! >= e && r.p_24h! < edges[k + 1]); if (i >= 0) { cnt[i].n++; cnt[i].y += r.resYes; } }
  return (p) => { const i = edges.findIndex((e, k) => p >= e && p < edges[k + 1]); const b = cnt[i]; return b && b.n >= 8 ? b.y / b.n : p; };
}
const emp = empBucketRate();

// strategy streams (net of half-spread)
function fadeLongshots(): Bet[] {            // SELL YES on cheap longshots (buy NO) — the cohort behaviour
  return data.filter((r) => r.p_24h! <= 0.15).map((r) => { const c = Math.min(0.999, 1 - r.p_24h! + H); return { c, win: 1 - r.resYes, q: 1 - emp(r.p_24h!) }; });
}
function buyFavorites(): Bet[] {             // BUY YES on heavy favorites
  return data.filter((r) => r.p_24h! >= 0.85).map((r) => { const c = Math.min(0.999, r.p_24h! + H); return { c, win: r.resYes, q: emp(r.p_24h!) }; });
}
function allMarkets(): Bet[] {               // bet toward the favorite side on everything
  return data.map((r) => { const fav = r.p_24h! >= 0.5; const c = Math.min(0.999, (fav ? r.p_24h! : 1 - r.p_24h!) + H); return { c, win: fav ? r.resYes : 1 - r.resYes, q: fav ? emp(r.p_24h!) : 1 - emp(r.p_24h!) }; });
}
// synthetic POSITIVE-edge control: 56% win on an even-money bet (true +12% edge per bet)
function syntheticEdge(seed: number): Bet[] { let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; return Array.from({ length: 800 }, () => ({ c: 0.5, win: rnd() < 0.56 ? 1 : 0, q: 0.56 })); }

const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// ---- money-management schemes: given (bankroll, bet, runState) -> stake fraction f of bankroll ----
type Scheme = { name: string; init?: () => any; f: (B: number, bet: Bet, st: any, lastWin: boolean | null) => number };
const kelly = (bet: Bet, frac: number) => { const b = rWin(bet.c); const q = bet.q, p = 1 - q; const fk = (b * q - p) / b; return Math.max(0, fk) * frac; };
const SCHEMES: Scheme[] = [
  { name: "flat 1% bankroll", f: () => 0.01 },
  { name: "fixed-frac 2%", f: () => 0.02 },
  { name: "fixed-frac 5%", f: () => 0.05 },
  { name: "fixed-frac 10%", f: () => 0.10 },
  { name: "fixed-frac 25%", f: () => 0.25 },
  { name: "full Kelly (mkt q)", f: (B, bet) => kelly({ ...bet, q: 1 - bet.c }, 1) }, // q = market price => calibrated
  { name: "full Kelly (emp q)", f: (B, bet) => kelly(bet, 1) },
  { name: "half Kelly (emp q)", f: (B, bet) => kelly(bet, 0.5) },
  { name: "quarter Kelly (emp q)", f: (B, bet) => kelly(bet, 0.25) },
  { name: "vol-target (10%/√n)", init: () => ({}), f: (B, bet) => Math.min(0.25, 0.10 / Math.sqrt(rWin(bet.c) * (1 - bet.c))) },
  { name: "Martingale (base2%,x2)", init: () => ({ run: 1 }), f: (B, bet, st, lw) => { if (lw === false) st.run = Math.min(st.run * 2, 32); else st.run = 1; return Math.min(0.95, 0.02 * st.run); } },
  { name: "anti-Martingale(2%,x2)", init: () => ({ run: 1 }), f: (B, bet, st, lw) => { if (lw === true) st.run = Math.min(st.run * 2, 16); else st.run = 1; return Math.min(0.95, 0.02 * st.run); } },
  { name: "D'Alembert (±1u)", init: () => ({ u: 1 }), f: (B, bet, st, lw) => { if (lw === false) st.u++; else if (lw === true) st.u = Math.max(1, st.u - 1); return Math.min(0.95, 0.01 * st.u); } },
  { name: "max-loss-cap 3%", f: () => 0.03 },
];

function simulate(stream: Bet[], scheme: Scheme, order: number[]): { terminal: number; ruined: boolean; maxDD: number } {
  let B = B0, peak = B0, maxDD = 0; const st = scheme.init ? scheme.init() : null; let lastWin: boolean | null = null; let ruined = false;
  for (const idx of order) {
    const bet = stream[idx];
    let f = scheme.f(B, bet, st, lastWin);
    f = Math.max(0, Math.min(0.99, f));
    const r = bet.win ? rWin(bet.c) : rLose;
    B *= (1 + f * r);
    lastWin = bet.win === 1;
    if (B < RUIN) { ruined = true; B = Math.max(B, 1e-9); }
    peak = Math.max(peak, B); maxDD = Math.max(maxDD, (peak - B) / peak);
  }
  return { terminal: B, ruined, maxDD };
}

function evalStream(name: string, stream: Bet[]) {
  if (stream.length < 20) { console.log(`\n## ${name}: too few bets (${stream.length})`); return; }
  const meanR = stream.reduce((s, b) => s + (b.win ? rWin(b.c) : rLose), 0) / stream.length;
  console.log(`\n## ${name}  (n=${stream.length}, per-bet mean net return = ${meanR >= 0 ? "+" : ""}${meanR.toFixed(4)})`);
  console.log("scheme                      medianTerminal   P(profit)   P(ruin)   medianMaxDD");
  const rng = seeded(7);
  for (const sc of SCHEMES) {
    const terms: number[] = []; let prof = 0, ruin = 0; const dds: number[] = [];
    for (let p = 0; p < PERM; p++) {
      const order = stream.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const res = simulate(stream, sc, order);
      terms.push(res.terminal); if (res.terminal > B0) prof++; if (res.ruined) ruin++; dds.push(res.maxDD);
    }
    terms.sort((a, b) => a - b); dds.sort((a, b) => a - b);
    const med = terms[terms.length >> 1];
    console.log(sc.name.padEnd(27), `$${med.toFixed(0)}`.padStart(13), `${(100 * prof / PERM).toFixed(1)}%`.padStart(11), `${(100 * ruin / PERM).toFixed(1)}%`.padStart(9), `${(100 * dds[dds.length >> 1]).toFixed(1)}%`.padStart(12));
  }
}

console.log(`=== PM money-management / risk gauntlet | start $${B0} | ${PERM} permutations ===`);
console.log(`Question: does ANY scheme turn the edge into profit? (positive expectancy is sizing-invariant)`);
evalStream("SYNTHETIC +12% edge (CONTROL — harness must show profit here)", syntheticEdge(123));
evalStream("Fade longshots (SELL YES <=0.15) — the cohort behaviour", fadeLongshots());
evalStream("Buy favorites (BUY YES >=0.85)", buyFavorites());
evalStream("Bet-the-favorite on all markets", allMarkets());
console.log(`\n=== If only the SYNTHETIC control grows, the verdict is: no money-management scheme rescues a ≤0 edge. ===`);
