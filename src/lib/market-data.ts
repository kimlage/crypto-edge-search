export type TimeframeUnit = "m" | "h" | "d";
export type CryptoTimeframe = `${number}${TimeframeUnit}`;

export interface OHLCVCandle {
  symbol: string;
  timeframe: CryptoTimeframe;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTimestamp: number;
  availableAt: number;
}

export interface GenerateDevCandlesOptions {
  symbol?: string;
  timeframe?: CryptoTimeframe;
  startTime?: number | Date;
  count: number;
  seed?: number | string;
  startPrice?: number;
  baseVolume?: number;
  trendPerCandle?: number;
  volatility?: number;
}

export const MIN_CRYPTO_TIMEFRAME_MS = 15 * 60 * 1000;
export const DEFAULT_DEV_START_TIME = Date.UTC(2024, 0, 1, 0, 0, 0);

const TIMEFRAME_PATTERN = /^([1-9]\d*)([mhd])$/;

export function timeframeToMilliseconds(timeframe: CryptoTimeframe): number {
  const match = TIMEFRAME_PATTERN.exec(timeframe);

  if (!match) {
    throw new Error(`Invalid crypto timeframe: ${timeframe}`);
  }

  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2] as TimeframeUnit;
  const multiplier =
    unit === "m" ? 60 * 1000 : unit === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const milliseconds = amount * multiplier;

  if (milliseconds < MIN_CRYPTO_TIMEFRAME_MS) {
    throw new Error("Crypto timeframes below 15m are not supported in this MVP");
  }

  return milliseconds;
}

export function normalizeTimestamp(input: number | Date | undefined): number {
  if (input === undefined) {
    return DEFAULT_DEV_START_TIME;
  }

  const timestamp = input instanceof Date ? input.getTime() : input;

  if (!Number.isFinite(timestamp)) {
    throw new Error("Timestamp must be a finite number or a valid Date");
  }

  return Math.trunc(timestamp);
}

export function generateDevCandles(options: GenerateDevCandlesOptions): OHLCVCandle[] {
  if (!Number.isInteger(options.count) || options.count < 0) {
    throw new Error("Dev candle count must be a non-negative integer");
  }

  const timeframe = options.timeframe ?? "15m";
  const timeframeMs = timeframeToMilliseconds(timeframe);
  const symbol = options.symbol ?? "BTCUSDT";
  const startTime = normalizeTimestamp(options.startTime);
  const random = createSeededRandom(options.seed ?? `${symbol}:${timeframe}:${startTime}`);
  const startPrice = finitePositiveOr(options.startPrice, 50_000);
  const baseVolume = finitePositiveOr(options.baseVolume, 1_000);
  const trendPerCandle = finiteOr(options.trendPerCandle, 0.00008);
  const volatility = finitePositiveOr(options.volatility, 0.009);
  const candles: OHLCVCandle[] = [];

  let previousClose = startPrice;

  for (let index = 0; index < options.count; index += 1) {
    const timestamp = startTime + index * timeframeMs;
    const phase = index / 24;
    const seasonalDrift = Math.sin(phase) * volatility * 0.2 + Math.cos(index / 73) * volatility * 0.08;
    const randomShock = (random() - 0.5) * volatility * 2;
    const returnRate = trendPerCandle + seasonalDrift + randomShock;
    const open = previousClose;
    const close = Math.max(0.01, open * (1 + returnRate));
    const wickScale = volatility * (0.25 + random() * 0.9);
    const high = Math.max(open, close) * (1 + wickScale);
    const low = Math.max(0.01, Math.min(open, close) * (1 - wickScale * (0.55 + random() * 0.65)));
    const volumeWave = 1 + Math.sin(index / 17) * 0.18 + Math.cos(index / 41) * 0.09;
    const volumeShock = 0.75 + random() * 0.7 + Math.abs(returnRate) * 18;
    const volume = Math.max(1, baseVolume * volumeWave * volumeShock);

    candles.push({
      symbol,
      timeframe,
      timestamp,
      open: roundTo(open, 8),
      high: roundTo(high, 8),
      low: roundTo(low, 8),
      close: roundTo(close, 8),
      volume: roundTo(volume, 8),
      closeTimestamp: timestamp + timeframeMs - 1,
      availableAt: timestamp + timeframeMs,
    });

    previousClose = close;
  }

  return candles;
}

export function assertChronologicalCandles(candles: readonly OHLCVCandle[]): void {
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp <= candles[index - 1].timestamp) {
      throw new Error("Candles must be strictly chronological");
    }
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

function finitePositiveOr(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function createSeededRandom(seed: number | string): () => number {
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
