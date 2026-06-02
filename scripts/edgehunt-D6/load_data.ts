/**
 * D6-M4 data loader. Builds an aligned daily panel of:
 *  - BTC daily close (nf1 OHLC 2017-08..2026-05, tail-extended w/ CoinMetrics PriceUSD)
 *  - DFII10 (10Y TIPS real yield, FRED no-key CSV, business days)
 *
 * STRICT t-1 causality is the consumer's responsibility: this loader only
 * aligns levels/changes BY DATE. The strategy must lag the macro signal so
 * that the real-yield value/change known *as of close t-1* positions for
 * return realized over t-1 -> t.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

export interface PanelRow {
  date: string; // YYYY-MM-DD (a BTC trading day)
  btcClose: number;
  btcRet: number; // log return close[t]/close[t-1]
  dfii10: number | null; // most-recent real yield level KNOWN at this date's close
  dfii10AsOfDate: string | null; // the observation date of that yield
}

function parseBtc(): Map<string, number> {
  const out = new Map<string, number>();
  // primary: nf1 OHLC (clean exchange close, 2017-08..2026-05-18)
  const nf1 = JSON.parse(
    readFileSync(resolve(ROOT, "output/nf1/BTC_daily_ohlc.json"), "utf8"),
  ) as Array<{ date: string; close: number }>;
  for (const r of nf1) {
    if (r.date && Number.isFinite(r.close)) out.set(r.date, r.close);
  }
  // tail-extend with CoinMetrics PriceUSD (covers 2026-05-19..2026-05-31)
  const cm = JSON.parse(
    readFileSync(resolve(ROOT, "output/edgehunt-D5/cm_extra_btc.json"), "utf8"),
  ) as { data: Array<{ time: string; PriceUSD?: string }> };
  for (const r of cm.data) {
    if (!r.PriceUSD) continue;
    const date = r.time.slice(0, 10);
    if (!out.has(date)) {
      const px = Number(r.PriceUSD);
      if (Number.isFinite(px)) out.set(date, px);
    }
  }
  return out;
}

function parseDfii10(): Array<{ date: string; value: number }> {
  const csv = readFileSync(
    resolve(ROOT, "output/edgehunt-D6/DFII10.csv"),
    "utf8",
  );
  const lines = csv.trim().split(/\r?\n/).slice(1); // drop header
  const out: Array<{ date: string; value: number }> = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    if (!date) continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out.push({ date, value: v });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * Build the aligned panel. For each BTC trading day t we attach the most
 * recent DFII10 observation whose date <= t (real yields publish on business
 * days; weekends/holidays carry forward the last known value — which is the
 * value actually known to a trader at t's close). This is point-in-time:
 * we never use a yield observation dated after t.
 */
export function loadPanel(startDate = "2017-08-17"): PanelRow[] {
  const btc = parseBtc();
  const yields = parseDfii10();

  const btcDates = [...btc.keys()].filter((d) => d >= startDate).sort();

  // two-pointer carry-forward of last-known yield
  let yi = 0;
  let lastYield: number | null = null;
  let lastYieldDate: string | null = null;

  const rows: PanelRow[] = [];
  let prevClose: number | null = null;
  for (const date of btcDates) {
    while (yi < yields.length && yields[yi].date <= date) {
      lastYield = yields[yi].value;
      lastYieldDate = yields[yi].date;
      yi += 1;
    }
    const close = btc.get(date)!;
    const ret =
      prevClose != null && prevClose > 0 ? Math.log(close / prevClose) : 0;
    rows.push({
      date,
      btcClose: close,
      btcRet: prevClose != null ? ret : 0,
      dfii10: lastYield,
      dfii10AsOfDate: lastYieldDate,
    });
    prevClose = close;
  }
  // drop the first row (no return) and rows with no yield yet
  return rows.filter((r, i) => i > 0 && r.dfii10 != null);
}

/** Annualization factor for daily series. */
export const ANN = Math.sqrt(365);

export function sharpe(returns: number[]): number {
  const v = returns.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(
    v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1),
  );
  return sd > 1e-12 ? (m / sd) * ANN : 0;
}

export function annReturn(returns: number[]): number {
  // compound, annualized
  const total = returns.reduce((a, b) => a + b, 0); // log-returns
  const years = returns.length / 365;
  return years > 0 ? Math.expm1(total / years) : 0;
}

export function maxDrawdown(returns: number[]): number {
  let cum = 0;
  let peak = 0;
  let mdd = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > mdd) mdd = dd;
  }
  return -Math.expm1(-mdd); // as a positive fraction
}
