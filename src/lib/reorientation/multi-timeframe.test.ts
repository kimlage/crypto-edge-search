import { describe, expect, it } from "vitest";

import { computeNetEdge } from "./turnover";
import {
  type BaseEntry,
  type Bias,
  type Side,
  barsPerHigherBar,
  buildHigherTimeframeBias,
  higherTimeframeGate,
  isHigherTimeframe,
  naiveMultiSignalUnion,
  orderTimeframes,
  TIMEFRAME_MINUTES,
  turnoverComparison,
} from "./multi-timeframe";

/** Deterministic mulberry32 RNG so the synthetic is reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shared cost scenario for the "tie to cost" test. A churny per-bar base executor (one
 * round-trip per bar, each capturing a single 15m move) vs a gated executor that enters
 * once per aligned higher bucket and HOLDS the whole bucket (one round-trip capturing the
 * summed aligned drift). Returns net-edge for both plus the turnover comparison.
 */
function runCostScenario() {
  const k = 16; // 15m → 4h
  const buckets = 24;
  const n = buckets * k;
  const rng = makeRng(2024);
  const driftPerBar = 0.0006; // real per-bar drift; alone it cannot beat a round-trip
  const noise = 0.0004;
  const roundTripCost = 0.0028;

  // Direction is a PERSISTENT regime (sticky trend), so a completed higher bar predicts
  // the next one — exactly the structure a higher-TF gate is designed to exploit. With
  // i.i.d. bucket directions a higher bar would carry no information; real markets trend
  // at higher timeframes more than at 15m, which is why the gate has an edge.
  const flipProb = 0.2; // 80% chance the regime persists into the next bucket
  const baseReturns: number[] = [];
  const bucketDir: number[] = [];
  let dir = rng() < 0.5 ? 1 : -1;
  for (let b = 0; b < buckets; b += 1) {
    if (b > 0 && rng() < flipProb) dir = -dir;
    bucketDir.push(dir);
    for (let j = 0; j < k; j += 1) {
      baseReturns.push(dir * driftPerBar + (rng() - 0.5) * 2 * noise);
    }
  }

  const { perBaseBar } = buildHigherTimeframeBias(baseReturns, { barsPerHigherBar: k });

  // CHURNER: one round-trip per bar, side = current higher bias (best case for it), only
  // where a completed higher bar exists. Each trade captures ONE bar's move — below cost.
  const baseEntries: BaseEntry[] = [];
  let baseGross = 0;
  for (let i = k; i < n; i += 1) {
    const bias = perBaseBar[i];
    const side: Side = bias === "down" ? "short" : "long";
    baseEntries.push({ index: i, side });
    const r = baseReturns[i] ?? 0;
    baseGross += side === "long" ? r : -r;
  }

  // GATED HOLD-THROUGH: for each completed bucket with a directional bias, enter at the
  // start of the NEXT bucket on the aligned side and hold the full bucket. The gate keeps
  // exactly these aligned entries; each is ONE round-trip capturing k bars of drift.
  const heldEntries: BaseEntry[] = [];
  let gatedGross = 0;
  for (let b = 1; b < buckets; b += 1) {
    const bias = perBaseBar[b * k]; // bias active across bucket b (from completed bucket b-1)
    if (bias === "flat") continue;
    const side: Side = bias === "down" ? "short" : "long";
    heldEntries.push({ index: b * k, side });
    let bucketReturn = 0;
    for (let j = 0; j < k; j += 1) bucketReturn += baseReturns[b * k + j] ?? 0;
    gatedGross += side === "long" ? bucketReturn : -bucketReturn;
  }

  // Confirm the gate keeps exactly the aligned hold entries (every kept entry's bias agrees).
  const { kept } = higherTimeframeGate({
    baseEntries: heldEntries,
    higherBias: perBaseBar,
    blockOnFlat: true,
  });

  const baseEdge = computeNetEdge({
    grossReturn: baseGross,
    tradeCount: baseEntries.length,
    roundTripCost,
  });
  const gatedEdge = computeNetEdge({
    grossReturn: gatedGross,
    tradeCount: kept.length,
    roundTripCost,
  });
  const cmp = turnoverComparison(baseEntries.length, kept.length, n);
  return { baseEdge, gatedEdge, cmp, baseGross, gatedGross };
}

describe("timeframe helpers", () => {
  it("orders timeframes by bar length", () => {
    expect(orderTimeframes(["1d", "15m", "4h", "1h", "1w"])).toEqual([
      "15m",
      "1h",
      "4h",
      "1d",
      "1w",
    ]);
  });

  it("recognizes higher timeframes and computes the ratio", () => {
    expect(isHigherTimeframe("15m", "1h")).toBe(true);
    expect(isHigherTimeframe("1h", "15m")).toBe(false);
    expect(isHigherTimeframe("4h", "4h")).toBe(false);
    expect(barsPerHigherBar("15m", "1h")).toBe(4);
    expect(barsPerHigherBar("15m", "4h")).toBe(16);
    expect(barsPerHigherBar("15m", "1d")).toBe(96);
    expect(barsPerHigherBar("1h", "1d")).toBe(24);
    expect(TIMEFRAME_MINUTES["1w"]).toBe(10080);
  });

  it("rejects non-higher or non-multiple ratios", () => {
    expect(() => barsPerHigherBar("1h", "15m")).toThrow();
  });
});

describe("buildHigherTimeframeBias (causal)", () => {
  it("labels base bars from the previous COMPLETED higher bar only", () => {
    // k=4. Bucket0 returns sum>0 (up), bucket1 sum<0 (down).
    const baseReturns = [1, 1, 1, 1, -1, -1, -1, -1, 5, 5, 5, 5];
    const { perBaseBar, higherBarBias } = buildHigherTimeframeBias(baseReturns, {
      barsPerHigherBar: 4,
    });
    expect(higherBarBias).toEqual<Bias[]>(["up", "down", "up"]);
    // First bucket (bars 0..3): no completed higher bar yet ⇒ flat.
    expect(perBaseBar.slice(0, 4)).toEqual<Bias[]>(["flat", "flat", "flat", "flat"]);
    // Bars 4..7 inherit bucket0 = up; bars 8..11 inherit bucket1 = down.
    expect(perBaseBar.slice(4, 8)).toEqual<Bias[]>(["up", "up", "up", "up"]);
    expect(perBaseBar.slice(8, 12)).toEqual<Bias[]>(["down", "down", "down", "down"]);
  });
});

describe("higherTimeframeGate — turnover never increases", () => {
  it("ALWAYS keeps <= base entries and strictly drops misaligned ones", () => {
    const higherBias: Bias[] = ["up", "up", "up", "up", "down", "down", "down", "down"];
    const baseEntries: BaseEntry[] = [
      { index: 0, side: "long" }, // aligned (up)
      { index: 1, side: "short" }, // misaligned
      { index: 2, side: "long" }, // aligned
      { index: 4, side: "short" }, // aligned (down)
      { index: 5, side: "long" }, // misaligned
      { index: 6, side: "short" }, // aligned
    ];
    const { kept, removed } = higherTimeframeGate({ baseEntries, higherBias });
    expect(kept.length).toBeLessThanOrEqual(baseEntries.length);
    expect(kept.length).toBe(4);
    expect(removed.length).toBe(2);
    expect(kept.map((e) => e.index)).toEqual([0, 2, 4, 6]);
  });

  it("stacking multiple higher TFs is strictly more selective (turnover drops further)", () => {
    const oneH: Bias[] = ["up", "up", "up", "up"];
    const fourH: Bias[] = ["up", "down", "up", "down"];
    const baseEntries: BaseEntry[] = [
      { index: 0, side: "long" },
      { index: 1, side: "long" },
      { index: 2, side: "long" },
      { index: 3, side: "long" },
    ];
    const single = higherTimeframeGate({ baseEntries, higherBias: oneH });
    const stacked = higherTimeframeGate({
      baseEntries,
      higherBias: oneH,
      additionalHigherBias: [fourH],
    });
    expect(single.kept.length).toBe(4);
    expect(stacked.kept.length).toBeLessThanOrEqual(single.kept.length);
    expect(stacked.kept.map((e) => e.index)).toEqual([0, 2]);
  });

  it("property: kept <= base over many random configs", () => {
    const rng = makeRng(42);
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 50;
      const higherBias: Bias[] = Array.from({ length: n }, () => {
        const r = rng();
        return r < 0.34 ? "up" : r < 0.67 ? "down" : "flat";
      });
      const baseEntries: BaseEntry[] = [];
      for (let i = 0; i < n; i += 1) {
        if (rng() < 0.5) {
          baseEntries.push({ index: i, side: rng() < 0.5 ? "long" : "short" });
        }
      }
      const { kept } = higherTimeframeGate({ baseEntries, higherBias });
      expect(kept.length).toBeLessThanOrEqual(baseEntries.length);
    }
  });
});

describe("naiveMultiSignalUnion — the WRONG approach increases entries", () => {
  it("produces MORE entries than any single timeframe alone", () => {
    const base15m = [0, 3, 6, 9, 12];
    const oneH = [1, 4, 7];
    const fourH = [2, 5, 8, 11, 14, 17];
    const union = naiveMultiSignalUnion({
      "15m": { entryIndices: base15m, side: "long" },
      "1h": { entryIndices: oneH, side: "long" },
      "4h": { entryIndices: fourH, side: "long" },
    });
    expect(union.length).toBeGreaterThan(base15m.length);
    expect(union.length).toBe(
      new Set([...base15m, ...oneH, ...fourH]).size,
    );
  });
});

describe("causality — future returns cannot change earlier decisions", () => {
  it("mutating a FUTURE base return leaves earlier bias and gating unchanged", () => {
    const n = 40;
    const k = 4;
    const rng = makeRng(7);
    const baseReturns = Array.from({ length: n }, () => rng() - 0.5);

    const before = buildHigherTimeframeBias(baseReturns, { barsPerHigherBar: k });

    // Pick an early bar t and mutate a return strictly AFTER it.
    const t = 13; // bucket 3
    const mutated = [...baseReturns];
    mutated[30] = 999; // far future
    mutated[27] = -999;
    const after = buildHigherTimeframeBias(mutated, { barsPerHigherBar: k });

    // Every base bar at index <= t must have identical bias.
    for (let i = 0; i <= t; i += 1) {
      expect(after.perBaseBar[i]).toBe(before.perBaseBar[i]);
    }

    // And the gating decision for an entry at bar t is unchanged.
    const entry: BaseEntry[] = [{ index: t, side: "long" }];
    const gateBefore = higherTimeframeGate({ baseEntries: entry, higherBias: before.perBaseBar });
    const gateAfter = higherTimeframeGate({ baseEntries: entry, higherBias: after.perBaseBar });
    expect(gateAfter.kept.length).toBe(gateBefore.kept.length);
  });
});

describe("tie to cost — gated strategy has higher net-of-cost edge per trade", () => {
  it("fewer, longer-held trades aligned with the higher-TF drift beat costs by more", () => {
    // Synthetic: each higher-TF bucket carries a real directional drift; base bars wiggle
    // around it. No SINGLE 15m bar move beats a 28 bps round-trip — that is the whole
    // problem with a per-bar churner. Gating doesn't just drop trades, it lets us HOLD
    // through the aligned higher bar: one round-trip then captures k bars of drift, so the
    // fixed cost is amortized and the per-trade edge clears it.
    const result = runCostScenario();
    const { baseEdge, gatedEdge, cmp } = result;

    // Fewer trades after gating (turnover down).
    expect(cmp.gatedEntries).toBeLessThan(cmp.baseEntries);
    // The gated, hold-through strategy clears costs per trade; the churny base does not.
    expect(gatedEdge.netEdgePerTrade).toBeGreaterThan(baseEdge.netEdgePerTrade);
    expect(gatedEdge.edgeBeatsCost).toBe(true);
    expect(baseEdge.edgeBeatsCost).toBe(false);
    // And net-of-cost the gated strategy is positive while the churner bleeds cost.
    expect(gatedEdge.netReturn).toBeGreaterThan(0);
    expect(baseEdge.netReturn).toBeLessThan(0);

    expect(cmp.entriesPerBarAfter).toBeLessThan(cmp.entriesPerBarBefore);
    expect(cmp.reductionPercent).toBeGreaterThan(0);
  });
});

// Suppress unused import warning for Side in environments that strip type-only usage.
const _sideCheck: Side = "long";
void _sideCheck;
