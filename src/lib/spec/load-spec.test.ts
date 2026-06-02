import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";

import { chargeExecutionCosts } from "../cost/execution-cost-model";
import {
  costSpecToExecutionModel,
  loadCostSpec,
  loadDatasetSpec,
  loadStrategySpec,
  parseSpecString,
  SpecValidationError,
} from "./load-spec";
import type { CostSpec } from "./types";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo-relative path to the committed example specs (no absolute machine path).
const EXAMPLES = path.resolve(dirname, "../../../examples/specs");

function readExample(name: string): string {
  return readFileSync(path.join(EXAMPLES, name), "utf8");
}

describe("loadStrategySpec", () => {
  it("loads the YAML and JSON example specs and round-trips equivalently", () => {
    const fromYaml = loadStrategySpec(readExample("strategy.example.yaml"));
    expect(fromYaml.strategy_id).toBe("xs-momentum-top30");
    expect(fromYaml.family).toBe("cross_sectional_momentum");
    expect(fromYaml.cadence).toBe("daily");
    expect(fromYaml.universe).toEqual({
      type: "top_by_volume",
      max_assets: 30,
      include_delisted: true,
    });
    expect(fromYaml.configs.lookback_days).toEqual([20, 40, 60, 90]);
    expect(fromYaml.trial_count_policy).toEqual({ mode: "grid" });
    expect(fromYaml.baselines).toContain("buy_and_hold");
    expect(fromYaml.surrogate).toEqual({ mode: "family_max", null: "structure", iterations: 200 });
    expect(fromYaml.holdout).toEqual({ mode: "tail", fraction: 0.2 });
    expect(fromYaml.statistic).toBe("sharpe");

    const fromJson = loadStrategySpec(readExample("strategy.example.json"));
    expect(fromJson.strategy_id).toBe("donchian-breakout-btc");
    expect(fromJson.trial_count_policy).toEqual({ mode: "explicit", count: 6 });

    // YAML and JSON loaders produce structurally identical objects when fed the SAME
    // spec serialized two ways (round-trip via the yaml stringifier).
    const reserialized = loadStrategySpec(toYaml(fromYaml));
    expect(reserialized).toEqual(fromYaml);
  });

  it("derives the same typed object from a JSON string and its YAML serialization", () => {
    const json = readExample("strategy.example.json");
    const specFromJson = loadStrategySpec(json);
    const specFromYaml = loadStrategySpec(toYaml(specFromJson));
    expect(specFromYaml).toEqual(specFromJson);
  });

  it("throws a clear, field-named error on a missing required field", () => {
    const spec = loadStrategySpec(readExample("strategy.example.json"));
    const broken = { ...spec } as Record<string, unknown>;
    delete broken.family;
    expect(() => loadStrategySpec(JSON.stringify(broken))).toThrow(SpecValidationError);
    expect(() => loadStrategySpec(JSON.stringify(broken))).toThrow(
      /missing required field 'family'/,
    );
  });

  it("throws on a mistyped (typo'd) enum value rather than silently accepting it", () => {
    const spec = loadStrategySpec(readExample("strategy.example.json"));
    const broken = { ...spec, cadence: "dialy" };
    expect(() => loadStrategySpec(JSON.stringify(broken))).toThrow(/cadence: must be one of/);
  });

  it("rejects an empty configs grid (no honest N to deflate by)", () => {
    const spec = loadStrategySpec(readExample("strategy.example.json"));
    const broken = { ...spec, configs: {} };
    expect(() => loadStrategySpec(JSON.stringify(broken))).toThrow(
      /configs: must declare at least one parameter/,
    );
  });

  it("rejects a holdout fraction outside [0, 1)", () => {
    const spec = loadStrategySpec(readExample("strategy.example.json"));
    const broken = { ...spec, holdout: { mode: "tail", fraction: 1 } };
    expect(() => loadStrategySpec(JSON.stringify(broken))).toThrow(/fraction: must be in \[0, 1\)/);
  });
});

describe("loadDatasetSpec", () => {
  it("loads the YAML and JSON example dataset specs", () => {
    const fromYaml = loadDatasetSpec(readExample("dataset.example.yaml"));
    expect(fromYaml.dataset_id).toBe("binance-spot-top30-daily-2019-2024");
    expect(fromYaml.source).toEqual({
      provider: "Binance",
      endpoint: "https://api.binance.com/api/v3/klines",
    });
    expect(fromYaml.period_start).toBe("2019-01-01");
    expect(fromYaml.period_end).toBe("2024-12-31");
    expect(fromYaml.symbols).toEqual(["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]);
    expect(fromYaml.known_biases).toEqual(["survivorship", "exchange_specific"]);
    expect(fromYaml.rate_limits).toEqual({ concurrency: 4 });

    const fromJson = loadDatasetSpec(readExample("dataset.example.json"));
    expect(fromJson.dataset_id).toBe("coinmetrics-community-btc-eth-daily");
    expect(fromJson.symbols).toEqual(["btc", "eth"]);
    expect(fromJson.rate_limits.concurrency).toBe(2);

    // Round-trip: serialize the JSON-loaded spec back to YAML and reload.
    expect(loadDatasetSpec(toYaml(fromJson))).toEqual(fromJson);
  });

  it("throws on missing symbols (caveats / provenance must never be silent)", () => {
    const spec = loadDatasetSpec(readExample("dataset.example.json"));
    const broken = { ...spec } as Record<string, unknown>;
    delete broken.symbols;
    expect(() => loadDatasetSpec(JSON.stringify(broken))).toThrow(
      /missing required field 'symbols'/,
    );
  });

  it("requires at least one known_biases entry", () => {
    const spec = loadDatasetSpec(readExample("dataset.example.json"));
    const broken = { ...spec, known_biases: [] };
    expect(() => loadDatasetSpec(JSON.stringify(broken))).toThrow(
      /known_biases: must have at least 1 item/,
    );
  });

  it("requires a positive-integer concurrency in rate_limits", () => {
    const spec = loadDatasetSpec(readExample("dataset.example.json"));
    const broken = { ...spec, rate_limits: { concurrency: 0 } };
    expect(() => loadDatasetSpec(JSON.stringify(broken))).toThrow(
      /rate_limits.concurrency: must be an integer ≥ 1/,
    );
  });

  it("accepts a bare-string source", () => {
    const spec = loadDatasetSpec(readExample("dataset.example.json"));
    const ok = { ...spec, source: "Binance public klines" };
    expect(loadDatasetSpec(JSON.stringify(ok)).source).toBe("Binance public klines");
  });
});

describe("loadCostSpec", () => {
  it("loads the YAML and JSON example cost specs", () => {
    const fromYaml = loadCostSpec(readExample("cost.example.yaml"));
    expect(fromYaml.taker_bps_per_side).toBe(5);
    expect(fromYaml.maker_fraction).toBe(0.25);
    expect(fromYaml.short_borrow_apr_by_venue).toEqual({ binance: 0.2, okx: 0.18 });
    expect(fromYaml.borrow_venue).toBe("binance");
    expect(fromYaml.futures_financing_apr).toBe(0.06);
    expect(fromYaml.risk_free_apr).toBe(0.04);

    const fromJson = loadCostSpec(readExample("cost.example.json"));
    expect(fromJson.taker_bps_per_side).toBe(4);
    expect(fromJson.maker_fraction).toBeUndefined();

    // Round-trip the YAML-loaded spec through the yaml stringifier.
    expect(loadCostSpec(toYaml(fromYaml))).toEqual(fromYaml);
  });

  it("throws on a missing required cost field", () => {
    const spec = loadCostSpec(readExample("cost.example.json"));
    const broken = { ...spec } as Record<string, unknown>;
    delete broken.slippage_bps;
    expect(() => loadCostSpec(JSON.stringify(broken))).toThrow(
      /missing required field 'slippage_bps'/,
    );
  });

  it("rejects a negative fee", () => {
    const spec = loadCostSpec(readExample("cost.example.json"));
    const broken = { ...spec, taker_bps_per_side: -1 };
    expect(() => loadCostSpec(JSON.stringify(broken))).toThrow(/taker_bps_per_side: must be ≥ 0/);
  });

  it("rejects a maker_fraction outside [0, 1]", () => {
    const spec = loadCostSpec(readExample("cost.example.json"));
    const broken = { ...spec, maker_fraction: 1.5 };
    expect(() => loadCostSpec(JSON.stringify(broken))).toThrow(/maker_fraction: must be in \[0, 1\]/);
  });
});

describe("costSpecToExecutionModel", () => {
  it("maps every CostSpec field onto the matching ExecutionCostModel field", () => {
    const spec: CostSpec = {
      taker_bps_per_side: 5,
      maker_bps_per_side: 1,
      maker_fraction: 0.25,
      slippage_bps: 2,
      short_borrow_apr_by_venue: { binance: 0.2, okx: 0.18 },
      borrow_venue: "binance",
      perp_funding_per_period: 0.0001,
      futures_financing_apr: 0.06,
      risk_free_apr: 0.04,
      margin_haircut: 0.00002,
    };
    const model = costSpecToExecutionModel(spec);
    expect(model).toEqual({
      takerBpsPerSide: 5,
      makerBpsPerSide: 1,
      makerFraction: 0.25,
      slippageBps: 2,
      shortBorrowAprByVenue: { binance: 0.2, okx: 0.18 },
      borrowVenue: "binance",
      perpFundingPerPeriod: 0.0001,
      futuresFinancingApr: 0.06,
      riskFreeApr: 0.04,
      marginHaircut: 0.00002,
    });
  });

  it("defaults all optional carry components to neutral (0 / empty) when absent", () => {
    const minimal: CostSpec = {
      taker_bps_per_side: 4,
      maker_bps_per_side: 1,
      slippage_bps: 1,
    };
    const model = costSpecToExecutionModel(minimal);
    expect(model.makerFraction).toBe(0);
    expect(model.shortBorrowAprByVenue).toEqual({});
    expect(model.perpFundingPerPeriod).toBe(0);
    expect(model.futuresFinancingApr).toBe(0);
    expect(model.riskFreeApr).toBe(0);
    expect(model.marginHaircut).toBe(0);
    expect(model.borrowVenue).toBeUndefined();
  });

  it("produces a model chargeExecutionCosts consumes — risk-free is charged on the FULL levered notional", () => {
    // The dated-futures-leak invariant: declaring risk_free_apr must charge the
    // long leg on the full leverage, not on 1 unit. Charge a flat-long book at 2.95x
    // and confirm the per-period risk-free cost scales with leverage.
    const spec = loadCostSpec(readExample("cost.example.yaml"));
    const model = costSpecToExecutionModel(spec);
    const grossReturns = Array.from({ length: 50 }, () => 0.001);

    const at1x = chargeExecutionCosts({ grossReturns, leverage: 1, periodsPerYear: 365, model });
    const at295x = chargeExecutionCosts({
      grossReturns,
      leverage: 2.95,
      periodsPerYear: 365,
      model,
    });

    // Risk-free is charged on the full long notional ⇒ ~2.95x the 1x charge.
    const rf1x = at1x.breakdown[0]!.riskFreeCost;
    const rf295x = at295x.breakdown[0]!.riskFreeCost;
    expect(rf1x).toBeGreaterThan(0);
    expect(rf295x / rf1x).toBeCloseTo(2.95, 6);
    // And the per-period risk-free charge equals risk_free_apr / periodsPerYear * longNotional.
    expect(rf295x).toBeCloseTo((0.04 / 365) * 2.95, 12);
  });
});

describe("parseSpecString", () => {
  it("parses a JSON string", () => {
    expect(parseSpecString('{"a":1}', "Test")).toEqual({ a: 1 });
  });

  it("falls back to YAML when the string is not JSON", () => {
    expect(parseSpecString("a: 1\nb: two\n", "Test")).toEqual({ a: 1, b: "two" });
  });

  it("throws on empty input", () => {
    expect(() => parseSpecString("   ", "Test")).toThrow(/empty input/);
  });
});
