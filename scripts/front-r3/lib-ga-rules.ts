/**
 * FRONT R3 — Genetic Programming that EVOLVES TRADING RULES.
 *
 * This library implements a REAL genetic algorithm (not a grid search). The
 * GENOME is a trading rule: a small conjunction/disjunction tree of conditions,
 * each condition = (indicator from a primitive library, comparator {>,<},
 * threshold), combined with AND/OR, mapping to a position {long, flat, short}.
 *
 * EVOLUTION uses tournament selection, real subtree/condition crossover between
 * parents, mutation (perturb thresholds, swap indicator/comparator, add/drop a
 * condition, flip AND/OR, flip position mapping), elitism over many generations.
 *
 * FITNESS = in-sample net-of-cost Sharpe with a turnover penalty, on TRAIN only.
 *
 * HONEST N = total number of UNIQUE genomes evaluated across ALL generations.
 *
 * Costs are realistic: taker 4 bps/side perp => 8 bps round-trip charged on
 * EVERY position change (|posChange| * costPerSide, since long->short is 2 sides).
 *
 * Pure / deterministic given a seed. No I/O here; the runner does I/O.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32 over a hashed string/number seed) — same family as the
// committed gates so behaviour is reproducible.
// ---------------------------------------------------------------------------
export function makeRng(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n) % Math.max(1, n);
}

function choice<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, arr.length)];
}

// ---------------------------------------------------------------------------
// Bars + indicator primitive library.
// All indicators are CAUSAL: feature[t] uses only data up to and including t,
// and the position taken at the open of bar t+1 (decision[t]) earns return[t+1].
// Each indicator series is normalized to a comparable scale and we precompute
// per-asset feature matrices so the GA only does cheap lookups during eval.
// ---------------------------------------------------------------------------
export interface Bar {
  date: string;
  close: number;
}

export const INDICATORS = [
  "rsi", // RSI(14), 0..100 -> rescaled to ~[-1,1] via (rsi-50)/50
  "macd", // MACD(12,26,9) histogram, normalized by rolling price std
  "bbpct", // Bollinger %b(20,2) centered: (%b - 0.5)*2 in ~[-1,1]
  "macross", // (MA10-MA30)/MA30 fast-slow MA cross, ~[-1,1] clamp
  "donch", // Donchian position(20): where close sits in [low,high] -> (pos-0.5)*2
  "atrmom", // ATR-normalized momentum: (close-close[N]) / (ATR14*sqrtN)
  "volregime", // realized-vol regime: zscore of 20d realized vol vs 100d
  "retN", // return-over-N: cumulative log-return over N bars, vol-normalized
] as const;
export type Indicator = (typeof INDICATORS)[number];

export interface FeatureMatrix {
  date: string[];
  close: number[];
  ret: number[]; // simple close-to-close return at bar t (ret[t] = close[t]/close[t-1]-1)
  features: Record<Indicator, number[]>; // each length = bars, NaN where warmup
  warmup: number; // first index where all features are finite
}

function sma(values: number[], period: number, end: number): number {
  if (end - period + 1 < 0) return NaN;
  let s = 0;
  for (let i = end - period + 1; i <= end; i += 1) s += values[i];
  return s / period;
}

function stdev(values: number[], period: number, end: number, mean: number): number {
  if (end - period + 1 < 0) return NaN;
  let s = 0;
  for (let i = end - period + 1; i <= end; i += 1) s += (values[i] - mean) ** 2;
  return Math.sqrt(s / period);
}

export function buildFeatures(bars: Bar[]): FeatureMatrix {
  const close = bars.map((b) => b.close);
  const date = bars.map((b) => b.date);
  const n = close.length;
  const ret = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i += 1) ret[i] = close[i] / close[i - 1] - 1;
  const logret = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i += 1) logret[i] = Math.log(close[i] / close[i - 1]);

  // High/Low proxies for daily spot-only series: use rolling close range.
  // (We only have closes; Donchian/ATR use close-based ranges, conservative.)
  const feat: Record<Indicator, number[]> = {
    rsi: new Array<number>(n).fill(NaN),
    macd: new Array<number>(n).fill(NaN),
    bbpct: new Array<number>(n).fill(NaN),
    macross: new Array<number>(n).fill(NaN),
    donch: new Array<number>(n).fill(NaN),
    atrmom: new Array<number>(n).fill(NaN),
    volregime: new Array<number>(n).fill(NaN),
    retN: new Array<number>(n).fill(NaN),
  };

  // RSI(14)
  const rsiPeriod = 14;
  for (let i = rsiPeriod; i < n; i += 1) {
    let gain = 0;
    let loss = 0;
    for (let k = i - rsiPeriod + 1; k <= i; k += 1) {
      const ch = close[k] - close[k - 1];
      if (ch > 0) gain += ch;
      else loss -= ch;
    }
    const rs = loss === 0 ? 100 : gain / loss;
    const rsi = loss === 0 && gain === 0 ? 50 : 100 - 100 / (1 + rs);
    feat.rsi[i] = (rsi - 50) / 50;
  }

  // MACD(12,26,9) histogram via EMAs, normalized by 26d price std
  const ema = (period: number): number[] => {
    const out = new Array<number>(n).fill(NaN);
    const alpha = 2 / (period + 1);
    let prev = close[0];
    out[0] = prev;
    for (let i = 1; i < n; i += 1) {
      prev = alpha * close[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  };
  const ema12 = ema(12);
  const ema26 = ema(26);
  const macdLine = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i += 1) macdLine[i] = ema12[i] - ema26[i];
  // signal = EMA9 of macdLine
  const signal = new Array<number>(n).fill(NaN);
  const a9 = 2 / (9 + 1);
  let prevSig = macdLine[0];
  signal[0] = prevSig;
  for (let i = 1; i < n; i += 1) {
    prevSig = a9 * macdLine[i] + (1 - a9) * prevSig;
    signal[i] = prevSig;
  }
  for (let i = 26; i < n; i += 1) {
    const m = sma(close, 26, i);
    const sd = stdev(close, 26, i, m);
    const hist = macdLine[i] - signal[i];
    feat.macd[i] = sd > 1e-9 ? clamp(hist / sd, -3, 3) / 3 : 0;
  }

  // Bollinger %b(20,2): (close - lower)/(upper-lower); centered & scaled to [-1,1]
  const bbPeriod = 20;
  for (let i = bbPeriod - 1; i < n; i += 1) {
    const m = sma(close, bbPeriod, i);
    const sd = stdev(close, bbPeriod, i, m);
    if (sd <= 1e-9) {
      feat.bbpct[i] = 0;
      continue;
    }
    const upper = m + 2 * sd;
    const lower = m - 2 * sd;
    const pctb = (close[i] - lower) / (upper - lower);
    feat.bbpct[i] = clamp((pctb - 0.5) * 2, -2, 2) / 2;
  }

  // MA cross (10,30): (ma10-ma30)/ma30
  for (let i = 29; i < n; i += 1) {
    const m10 = sma(close, 10, i);
    const m30 = sma(close, 30, i);
    feat.macross[i] = m30 > 1e-9 ? clamp((m10 - m30) / m30, -0.3, 0.3) / 0.3 : 0;
  }

  // Donchian position(20): where close sits in rolling [min,max] of closes
  const donchPeriod = 20;
  for (let i = donchPeriod - 1; i < n; i += 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = i - donchPeriod + 1; k <= i; k += 1) {
      if (close[k] < lo) lo = close[k];
      if (close[k] > hi) hi = close[k];
    }
    const pos = hi - lo > 1e-9 ? (close[i] - lo) / (hi - lo) : 0.5;
    feat.donch[i] = (pos - 0.5) * 2;
  }

  // ATR(14)-normalized momentum over N=10: (close - close[i-10]) / (ATR*sqrt(10))
  const atrPeriod = 14;
  const momN = 10;
  const atr = new Array<number>(n).fill(NaN);
  for (let i = atrPeriod; i < n; i += 1) {
    let s = 0;
    for (let k = i - atrPeriod + 1; k <= i; k += 1) s += Math.abs(close[k] - close[k - 1]);
    atr[i] = s / atrPeriod;
  }
  for (let i = atrPeriod + momN; i < n; i += 1) {
    const denom = atr[i] * Math.sqrt(momN);
    feat.atrmom[i] = denom > 1e-9 ? clamp((close[i] - close[i - momN]) / denom, -4, 4) / 4 : 0;
  }

  // realized-vol regime: zscore of 20d realized vol relative to 100d distribution
  const volShort = 20;
  const volLong = 100;
  const rv = new Array<number>(n).fill(NaN);
  for (let i = volShort; i < n; i += 1) {
    let s = 0;
    for (let k = i - volShort + 1; k <= i; k += 1) s += logret[k] * logret[k];
    rv[i] = Math.sqrt(s / volShort);
  }
  for (let i = volLong + volShort; i < n; i += 1) {
    let m = 0;
    let cnt = 0;
    for (let k = i - volLong + 1; k <= i; k += 1) {
      if (Number.isFinite(rv[k])) {
        m += rv[k];
        cnt += 1;
      }
    }
    m /= Math.max(1, cnt);
    let sd = 0;
    for (let k = i - volLong + 1; k <= i; k += 1) {
      if (Number.isFinite(rv[k])) sd += (rv[k] - m) ** 2;
    }
    sd = Math.sqrt(sd / Math.max(1, cnt));
    feat.volregime[i] = sd > 1e-9 ? clamp((rv[i] - m) / sd, -3, 3) / 3 : 0;
  }

  // return-over-N (N=20) vol-normalized cumulative log-return
  const retNPeriod = 20;
  for (let i = retNPeriod + volShort; i < n; i += 1) {
    let cum = 0;
    for (let k = i - retNPeriod + 1; k <= i; k += 1) cum += logret[k];
    const denom = rv[i] * Math.sqrt(retNPeriod);
    feat.retN[i] = denom > 1e-9 ? clamp(cum / denom, -3, 3) / 3 : 0;
  }

  // warmup = first index where every feature is finite
  let warmup = 0;
  for (let i = 0; i < n; i += 1) {
    let ok = true;
    for (const ind of INDICATORS) {
      if (!Number.isFinite(feat[ind][i])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      warmup = i;
      break;
    }
  }

  return { date, close, ret, features: feat, warmup };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// GENOME: a rule tree.
//   Condition = { indicator, comparator, threshold }  (threshold in feature units, ~[-1,1])
//   A genome is a list of (1..maxConds) conditions combined by a single logical
//   operator (AND/OR) — a depth-1 conjunction/disjunction tree, the classic GP
//   rule shape. When the combined predicate is TRUE the rule takes `posTrue`,
//   otherwise `posFalse`. positions in {-1 short, 0 flat, +1 long}.
// This is a genuine tree with crossover at the condition level and mutation at
// the node and structure level.
// ---------------------------------------------------------------------------
export type Comparator = ">" | "<";
export interface Condition {
  indicator: Indicator;
  comparator: Comparator;
  threshold: number; // feature-space threshold, ~[-1,1]
}
export type LogicalOp = "AND" | "OR";
export type Position = -1 | 0 | 1;

export interface Genome {
  conditions: Condition[];
  op: LogicalOp;
  posTrue: Position;
  posFalse: Position;
}

export const MAX_CONDITIONS = 4;
const THRESH_LO = -1;
const THRESH_HI = 1;
const POSITIONS: Position[] = [-1, 0, 1];

export function randomCondition(rng: () => number): Condition {
  return {
    indicator: choice(rng, INDICATORS),
    comparator: rng() < 0.5 ? ">" : "<",
    threshold: round3(THRESH_LO + rng() * (THRESH_HI - THRESH_LO)),
  };
}

export function randomGenome(rng: () => number): Genome {
  const nConds = 1 + randInt(rng, MAX_CONDITIONS);
  const conditions = Array.from({ length: nConds }, () => randomCondition(rng));
  // ensure posTrue != posFalse so the rule actually trades
  let posTrue = choice(rng, POSITIONS);
  let posFalse = choice(rng, POSITIONS);
  let guard = 0;
  while (posTrue === posFalse && guard < 8) {
    posFalse = choice(rng, POSITIONS);
    guard += 1;
  }
  return { conditions, op: rng() < 0.5 ? "AND" : "OR", posTrue, posFalse };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Canonical string key for a genome — used to count UNIQUE genomes (honest N). */
export function genomeKey(g: Genome): string {
  const conds = g.conditions
    .map((c) => `${c.indicator}${c.comparator}${c.threshold.toFixed(3)}`)
    .sort()
    .join("&");
  return `${g.op}|${conds}|T${g.posTrue}|F${g.posFalse}`;
}

/** Plain-English description of a genome. */
export function describeGenome(g: Genome): string {
  const conds = g.conditions
    .map((c) => `${c.indicator} ${c.comparator} ${c.threshold.toFixed(3)}`)
    .join(` ${g.op} `);
  const pos = (p: Position) => (p === 1 ? "LONG" : p === -1 ? "SHORT" : "FLAT");
  return `IF (${conds}) THEN ${pos(g.posTrue)} ELSE ${pos(g.posFalse)}`;
}

// ---------------------------------------------------------------------------
// Evaluate a genome -> per-asset decision series -> net-of-cost return series.
// Decision at bar t (using features up to t) earns ret[t+1]. Cost charged on
// |position[t] - position[t-1]| * costPerSide (so a long->short flip = 2 sides).
// We POOL across assets: concatenate each asset's net daily returns. Fitness is
// the pooled net Sharpe minus a turnover penalty.
// ---------------------------------------------------------------------------
export interface EvalConfig {
  costPerSide: number; // e.g. 0.0004 (4 bps)
  turnoverPenalty: number; // lambda on annualized-ish turnover, in Sharpe units
  startIdx: number; // first decision index (>= warmup) per asset
  endIdx: number; // exclusive: last decision index uses ret up to endIdx
}

export interface EvalResult {
  netReturns: number[]; // pooled per-bar net returns (decision bars only)
  grossReturns: number[];
  positionChanges: number; // total number of position changes (for turnover)
  bars: number; // number of decision bars
  turnover: number; // mean |dPos| per bar
}

function predicate(g: Genome, fm: FeatureMatrix, t: number): Position {
  let result: boolean;
  if (g.op === "AND") {
    result = true;
    for (const c of g.conditions) {
      const v = fm.features[c.indicator][t];
      const cond = c.comparator === ">" ? v > c.threshold : v < c.threshold;
      if (!cond) {
        result = false;
        break;
      }
    }
  } else {
    result = false;
    for (const c of g.conditions) {
      const v = fm.features[c.indicator][t];
      const cond = c.comparator === ">" ? v > c.threshold : v < c.threshold;
      if (cond) {
        result = true;
        break;
      }
    }
  }
  return result ? g.posTrue : g.posFalse;
}

/**
 * Evaluate a genome over a list of per-asset feature matrices restricted to a
 * decision window. `startIdx`/`endIdx` are INCLUSIVE decision-bar indices; a
 * decision at bar t earns ret[t+1], so the last usable decision index is hard
 * capped at ret.length-2 (never reads past the series end). Returns the pooled
 * net/gross series (one entry per (asset, decision-bar)) plus turnover.
 */
export function evaluateGenome(
  g: Genome,
  fms: FeatureMatrix[],
  cfg: EvalConfig,
): EvalResult {
  const net: number[] = [];
  const gross: number[] = [];
  let posChanges = 0;
  let dPosSum = 0;
  let barCount = 0;

  for (const fm of fms) {
    const start = Math.max(cfg.startIdx, fm.warmup);
    const end = Math.min(cfg.endIdx, fm.ret.length - 2); // ret[t+1] must exist
    let prevPos: Position = 0;
    for (let t = start; t <= end; t += 1) {
      const pos = predicate(g, fm, t);
      const dPos = Math.abs(pos - prevPos);
      const cost = dPos * cfg.costPerSide;
      const r = fm.ret[t + 1]; // decision at t earns next-bar return
      if (!Number.isFinite(r)) {
        prevPos = pos;
        continue;
      }
      const grossR = pos * r;
      gross.push(grossR);
      net.push(grossR - cost);
      if (dPos > 0) posChanges += 1;
      dPosSum += dPos;
      barCount += 1;
      prevPos = pos;
    }
  }

  return {
    netReturns: net,
    grossReturns: gross,
    positionChanges: posChanges,
    bars: barCount,
    turnover: barCount > 0 ? dPosSum / barCount : 0,
  };
}

/** Sharpe of a return series (per-bar, no annualization — comparisons are relative). */
export function sharpe(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  let m = 0;
  for (const r of returns) m += r;
  m /= n;
  let v = 0;
  for (const r of returns) v += (r - m) ** 2;
  v /= n - 1;
  const sd = Math.sqrt(v);
  return sd > 1e-12 ? m / sd : 0;
}

/** Fitness on TRAIN: net Sharpe minus turnover penalty. Degenerate rules score 0. */
export function fitness(g: Genome, fms: FeatureMatrix[], cfg: EvalConfig): number {
  const ev = evaluateGenome(g, fms, cfg);
  if (ev.bars < 30) return -1e6;
  const s = sharpe(ev.netReturns);
  // turnover penalty: penalize churn (cfg.turnover ~ mean |dPos|, 0..2)
  return s - cfg.turnoverPenalty * ev.turnover;
}

// ---------------------------------------------------------------------------
// GA operators: tournament selection, crossover, mutation, elitism.
// ---------------------------------------------------------------------------
export function cloneGenome(g: Genome): Genome {
  return {
    conditions: g.conditions.map((c) => ({ ...c })),
    op: g.op,
    posTrue: g.posTrue,
    posFalse: g.posFalse,
  };
}

/** CROSSOVER: recombine conditions between two parents (subtree exchange) + mix mappings. */
export function crossover(a: Genome, b: Genome, rng: () => number): [Genome, Genome] {
  const child1 = cloneGenome(a);
  const child2 = cloneGenome(b);
  // exchange a random subset (suffix) of conditions between parents
  const cut1 = randInt(rng, a.conditions.length);
  const cut2 = randInt(rng, b.conditions.length);
  const head1 = a.conditions.slice(0, cut1).map((c) => ({ ...c }));
  const tail1 = a.conditions.slice(cut1).map((c) => ({ ...c }));
  const head2 = b.conditions.slice(0, cut2).map((c) => ({ ...c }));
  const tail2 = b.conditions.slice(cut2).map((c) => ({ ...c }));
  child1.conditions = trimConds([...head1, ...tail2]);
  child2.conditions = trimConds([...head2, ...tail1]);
  // mix logical op and position mapping
  if (rng() < 0.5) child1.op = b.op;
  if (rng() < 0.5) child2.op = a.op;
  if (rng() < 0.5) child1.posTrue = b.posTrue;
  if (rng() < 0.5) child1.posFalse = b.posFalse;
  if (rng() < 0.5) child2.posTrue = a.posTrue;
  if (rng() < 0.5) child2.posFalse = a.posFalse;
  return [child1, child2];
}

function trimConds(conds: Condition[]): Condition[] {
  if (conds.length === 0) return [conds[0]].filter(Boolean) as Condition[];
  if (conds.length > MAX_CONDITIONS) return conds.slice(0, MAX_CONDITIONS);
  return conds;
}

/** MUTATION: perturb thresholds, swap indicator/comparator, add/drop condition, flip op/position. */
export function mutate(g: Genome, rng: () => number, rate: number): Genome {
  const child = cloneGenome(g);
  // per-condition mutations
  for (const c of child.conditions) {
    if (rng() < rate) {
      // perturb threshold by gaussian-ish step
      const step = (rng() - 0.5) * 0.4;
      c.threshold = round3(clamp(c.threshold + step, THRESH_LO, THRESH_HI));
    }
    if (rng() < rate * 0.5) c.indicator = choice(rng, INDICATORS);
    if (rng() < rate * 0.5) c.comparator = c.comparator === ">" ? "<" : ">";
  }
  // structural: add a condition
  if (rng() < rate * 0.6 && child.conditions.length < MAX_CONDITIONS) {
    child.conditions.push(randomCondition(rng));
  }
  // structural: drop a condition
  if (rng() < rate * 0.6 && child.conditions.length > 1) {
    child.conditions.splice(randInt(rng, child.conditions.length), 1);
  }
  // flip logical op
  if (rng() < rate * 0.4) child.op = child.op === "AND" ? "OR" : "AND";
  // mutate position mapping
  if (rng() < rate * 0.4) child.posTrue = choice(rng, POSITIONS);
  if (rng() < rate * 0.4) child.posFalse = choice(rng, POSITIONS);
  return child;
}

export interface GaConfig {
  populationSize: number;
  generations: number;
  tournamentSize: number;
  eliteCount: number;
  crossoverRate: number;
  mutationRate: number;
  seed: number | string;
}

export interface GaResult {
  champion: Genome;
  championFitness: number;
  uniqueGenomes: number; // HONEST N
  totalEvaluations: number;
  generationsBest: number[];
}

/**
 * Run the GA on the supplied TRAIN feature matrices. Returns the champion plus
 * the count of UNIQUE genomes ever evaluated (honest N for multiple-testing).
 * Fitness is cached per unique genome key so honest N == cache size.
 */
export function runGa(
  trainFms: FeatureMatrix[],
  evalCfg: EvalConfig,
  ga: GaConfig,
): GaResult {
  const rng = makeRng(ga.seed);
  const fitCache = new Map<string, number>();
  let totalEvaluations = 0;

  const evalFit = (g: Genome): number => {
    const key = genomeKey(g);
    const cached = fitCache.get(key);
    if (cached !== undefined) return cached;
    const f = fitness(g, trainFms, evalCfg);
    fitCache.set(key, f);
    totalEvaluations += 1;
    return f;
  };

  // initial population
  let population: Genome[] = Array.from({ length: ga.populationSize }, () =>
    randomGenome(rng),
  );
  const generationsBest: number[] = [];

  for (let gen = 0; gen < ga.generations; gen += 1) {
    // evaluate
    const scored = population.map((g) => ({ g, f: evalFit(g) }));
    scored.sort((x, y) => y.f - x.f);
    generationsBest.push(scored[0].f);

    // next generation
    const next: Genome[] = [];
    // elitism
    for (let e = 0; e < ga.eliteCount && e < scored.length; e += 1) {
      next.push(cloneGenome(scored[e].g));
    }
    const tournament = (): Genome => {
      let best: { g: Genome; f: number } | null = null;
      for (let i = 0; i < ga.tournamentSize; i += 1) {
        const cand = scored[randInt(rng, scored.length)];
        if (best === null || cand.f > best.f) best = cand;
      }
      return best!.g;
    };
    while (next.length < ga.populationSize) {
      const p1 = tournament();
      const p2 = tournament();
      let c1: Genome;
      let c2: Genome;
      if (rng() < ga.crossoverRate) {
        [c1, c2] = crossover(p1, p2, rng);
      } else {
        c1 = cloneGenome(p1);
        c2 = cloneGenome(p2);
      }
      c1 = mutate(c1, rng, ga.mutationRate);
      c2 = mutate(c2, rng, ga.mutationRate);
      next.push(c1);
      if (next.length < ga.populationSize) next.push(c2);
    }
    population = next;
  }

  // final evaluation to pick champion across the LAST population + cache best
  const finalScored = population.map((g) => ({ g, f: evalFit(g) }));
  finalScored.sort((x, y) => y.f - x.f);
  // champion = best UNIQUE genome ever seen (search over the whole cache via re-scan
  // of final pop + elites is sufficient since elites persist; but to be exact we
  // track the global best by re-evaluating from cache keys is not possible — so we
  // keep the best of the final population which contains the persisted elites).
  const champion = finalScored[0].g;
  const championFitness = finalScored[0].f;

  return {
    champion: cloneGenome(champion),
    championFitness,
    uniqueGenomes: fitCache.size,
    totalEvaluations,
    generationsBest,
  };
}

// ---------------------------------------------------------------------------
// SURROGATE generators — destroy genuine structure/regime while preserving
// volatility & short-range autocorrelation. We surrogate the RETURN series and
// rebuild closes, then rebuild features. Two methods:
//   1. phase randomization (FFT phase scramble of returns) — preserves the power
//      spectrum (=> autocorrelation) but destroys nonlinear/regime structure.
//   2. stationary/circular block bootstrap — preserves short-range autocorr by
//      resampling contiguous blocks, destroys long-range structure & regime order.
// ---------------------------------------------------------------------------
export function blockBootstrapReturns(
  ret: number[],
  blockLen: number,
  rng: () => number,
): number[] {
  const n = ret.length;
  const out: number[] = [];
  while (out.length < n) {
    const start = randInt(rng, n);
    for (let k = 0; k < blockLen && out.length < n; k += 1) {
      out.push(ret[(start + k) % n]);
    }
  }
  return out.slice(0, n);
}

/** Phase-randomization surrogate of a (log)return series via naive DFT. */
export function phaseRandomizeReturns(ret: number[], rng: () => number): number[] {
  const n = ret.length;
  // demean
  let mean = 0;
  for (const r of ret) mean += r;
  mean /= n;
  const x = ret.map((r) => r - mean);
  // DFT
  const re = new Array<number>(n).fill(0);
  const im = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k += 1) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t += 1) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += x[t] * Math.cos(ang);
      si += x[t] * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  // randomize phases (keep magnitude), preserve conjugate symmetry for real output
  const mag = re.map((r, k) => Math.sqrt(r * r + im[k] * im[k]));
  const phase = new Array<number>(n).fill(0);
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k += 1) {
    const ph = (rng() * 2 - 1) * Math.PI;
    phase[k] = ph;
    if (k !== n - k) phase[n - k] = -ph; // conjugate symmetry
  }
  // inverse DFT
  const out = new Array<number>(n).fill(0);
  for (let t = 0; t < n; t += 1) {
    let s = 0;
    for (let k = 0; k < n; k += 1) {
      const ang = (2 * Math.PI * k * t) / n + phase[k];
      s += mag[k] * Math.cos(ang);
    }
    out[t] = s / n + mean;
  }
  return out;
}

/** Rebuild a Bar[] (closes) from a return series starting at a base price. */
export function barsFromReturns(dates: string[], ret: number[], basePrice = 100): Bar[] {
  const bars: Bar[] = [];
  let price = basePrice;
  for (let i = 0; i < ret.length; i += 1) {
    price *= 1 + ret[i];
    if (!Number.isFinite(price) || price <= 0) price = 1e-6;
    bars.push({ date: dates[i] ?? `s${i}`, close: price });
  }
  return bars;
}
