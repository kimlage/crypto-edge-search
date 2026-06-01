import { describe, expect, it } from "vitest";
import {
  MIN_CRYPTO_TIMEFRAME_MS,
  generateDevCandles,
  timeframeToMilliseconds,
} from "./market-data";

describe("market-data", () => {
  it("generates deterministic OHLCV candles at 15m or higher", () => {
    const options = {
      count: 16,
      timeframe: "15m" as const,
      startTime: Date.UTC(2024, 0, 1),
      seed: "demo-seed",
    };
    const first = generateDevCandles(options);
    const second = generateDevCandles(options);

    expect(first).toEqual(second);
    expect(first).toHaveLength(16);
    expect(timeframeToMilliseconds("15m")).toBe(MIN_CRYPTO_TIMEFRAME_MS);

    for (let index = 0; index < first.length; index += 1) {
      const candle = first[index];
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
      expect(candle.volume).toBeGreaterThan(0);

      if (index > 0) {
        expect(candle.timestamp - first[index - 1].timestamp).toBe(MIN_CRYPTO_TIMEFRAME_MS);
      }
    }
  });

  it("rejects sub-15m crypto timeframes", () => {
    expect(() => timeframeToMilliseconds("5m")).toThrow(/below 15m/);
    expect(() => generateDevCandles({ count: 1, timeframe: "1m" })).toThrow(/below 15m/);
  });
});
