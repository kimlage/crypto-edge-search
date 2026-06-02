/**
 * Q6-DVOLTS data prep.
 *
 * Builds a daily panel aligned to the free Deribit BTC DVOL index:
 *   - dvol[t]      : 30-day constant-maturity implied vol (Deribit DVOL close), annualized %.
 *   - backProxy[t] : "back-month" implied-vol proxy. DVOL is a single 30d tenor, so we approximate
 *                    a longer-tenor implied by the standard VIX/VXV roll trick: a slower EMA of DVOL
 *                    (vol term structures mean-revert; the longer tenor is the smoothed anchor).
 *                    slope = dvol/backProxy; contango = front<back (slope<1) = rich to sell.
 *   - rv[t]        : trailing 30-day realized vol (annualized %) from 15m close-to-close returns,
 *                    scaled to a daily-vol basis (causal: uses returns up to and including day t).
 *   - rvFwd7[t]    : forward 7-day realized vol over (t, t+7] -- used only for diagnostics / the
 *                    short-vol payoff proxy, never as a signal.
 *   - price[t]     : daily BTC close (from 15m last bar of the day).
 *   - logRet[t]    : daily close-to-close log return price[t-1]->price[t].
 *   - fwdRet[t]    : daily log return price[t]->price[t+1] (the spot exposure of a hedged book leg).
 *
 * Short-vol carry payoff proxy (per day, annualized-vol-points basis):
 *   sellVolPnl[t] = (impliedVar30[t] - realizedVarFwd[t over the holding period]) sign-correct so
 *   that selling vol earns when implied>realized. We model the daily short-vol carry leg as
 *   proportional to (dvol[t]^2 - rvFwd[t]^2) (variance swap analogue), per Britten-Jones-Neuberger.
 *
 * All series strictly causal. Output cached to output/edgehunt-quant/dvolts_panel.json.
 */
import fs from "node:fs";

const ROOT = ".";
const OHLCV = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;
const DVOL = `${ROOT}/output/edgehunt/dvol_btc.json`;
const OUT = `${ROOT}/output/edgehunt-quant/dvolts_panel.json`;

// ---- 1. aggregate 15m OHLCV -> daily close + daily realized variance from 15m log returns ----
// We accumulate sum of squared 15m log returns per UTC day -> daily realized variance; annualize.
interface DayAgg {
  date: string;
  close: number;
  rv2_15m: number; // sum of squared 15m log returns within the day (daily realized variance)
  nbars: number;
}

function buildDaily(): DayAgg[] {
  const byDay = new Map<string, { close: number; lastTs: number; rv2: number; nbars: number; prevClose: number }>();
  const lines = fs.readFileSync(OHLCV, "utf8").split("\n");
  // pass 1: collect per-bar close keyed by timestamp order per day
  // we need consecutive 15m closes for log returns; iterate in file order (ascending).
  let prevClose = NaN;
  for (const ln of lines) {
    if (!ln) continue;
    const r = JSON.parse(ln);
    const date: string = r.event_date;
    const close: number = r.close;
    const ts = Date.parse(r.event_time);
    if (!(close > 0)) continue;
    let d = byDay.get(date);
    if (!d) {
      d = { close, lastTs: ts, rv2: 0, nbars: 0, prevClose: NaN };
      byDay.set(date, d);
    }
    // 15m log return vs previous bar (cross-day boundary returns counted in the day they end)
    if (Number.isFinite(prevClose) && prevClose > 0) {
      const lr = Math.log(close / prevClose);
      d.rv2 += lr * lr;
      d.nbars += 1;
    }
    if (ts >= d.lastTs) {
      d.lastTs = ts;
      d.close = close;
    }
    prevClose = close;
  }
  const out: DayAgg[] = [];
  for (const [date, d] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (d.nbars < 80) continue; // require a reasonably full day (96 bars ideal)
    out.push({ date, close: d.close, rv2_15m: d.rv2, nbars: d.nbars });
  }
  return out;
}

function main() {
  const daily = buildDaily();
  const dayIdx = new Map<string, number>();
  daily.forEach((d, i) => dayIdx.set(d.date, i));

  // annualized realized vol from intraday rv2 (rv2 is daily variance from 15m returns)
  // daily realized vol = sqrt(rv2_15m); annualize by sqrt(365).
  const ANN = Math.sqrt(365);
  const dailyRVann = daily.map((d) => Math.sqrt(d.rv2_15m) * ANN * 100); // in vol "points" like DVOL

  // trailing 30-day average realized vol (annualized %), causal
  const rv30 = new Array(daily.length).fill(NaN);
  for (let i = 0; i < daily.length; i++) {
    if (i < 29) continue;
    let s = 0;
    let ok = true;
    for (let k = i - 29; k <= i; k++) {
      if (!Number.isFinite(dailyRVann[k])) {
        ok = false;
        break;
      }
      s += dailyRVann[k] * dailyRVann[k]; // average variance then sqrt
    }
    if (ok) rv30[i] = Math.sqrt(s / 30);
  }
  // forward 7-day realized vol over (t, t+7] (diagnostic only)
  const rvFwd7 = new Array(daily.length).fill(NaN);
  for (let i = 0; i < daily.length; i++) {
    if (i + 7 >= daily.length) continue;
    let s = 0;
    let ok = true;
    for (let k = i + 1; k <= i + 7; k++) {
      if (!Number.isFinite(dailyRVann[k])) {
        ok = false;
        break;
      }
      s += dailyRVann[k] * dailyRVann[k];
    }
    if (ok) rvFwd7[i] = Math.sqrt(s / 7);
  }

  // ---- 2. load DVOL daily, align to daily price dates ----
  const dvolRaw: { date: string; close: number }[] = JSON.parse(fs.readFileSync(DVOL, "utf8")).map(
    (r: any) => ({ date: r.date, close: Number(r.close) }),
  );
  const dvolMap = new Map<string, number>();
  for (const r of dvolRaw) if (r.close > 0) dvolMap.set(r.date, r.close);

  // intersection: dates with both price and dvol
  const dates: string[] = [];
  const price: number[] = [];
  const dvol: number[] = [];
  const rv: number[] = [];
  const rvf7: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    const dt = daily[i].date;
    const dv = dvolMap.get(dt);
    if (dv == null) continue;
    dates.push(dt);
    price.push(daily[i].close);
    dvol.push(dv);
    rv.push(rv30[i]);
    rvf7.push(rvFwd7[i]);
  }

  // daily log returns and forward returns on the aligned grid
  const T = price.length;
  const logRet = new Array(T).fill(NaN);
  const fwdRet = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    if (t > 0) logRet[t] = Math.log(price[t] / price[t - 1]);
    if (t + 1 < T) fwdRet[t] = Math.log(price[t + 1] / price[t]);
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify({
      meta: {
        firstDate: dates[0],
        lastDate: dates[T - 1],
        n: T,
        note: "Q6-DVOLTS aligned panel: BTC DVOL (30d CM IV) + 15m-derived RV + price",
      },
      dates,
      price,
      dvol, // 30d const-maturity implied vol, ann %
      rv, // trailing 30d realized vol, ann %
      rvFwd7: rvf7, // forward 7d realized vol, ann % (diagnostic)
      logRet,
      fwdRet,
    }),
  );
  console.log(`wrote ${OUT}`);
  console.log(`T=${T} span ${dates[0]}..${dates[T - 1]}`);
  // quick sanity
  const finiteRV = rv.filter((x) => Number.isFinite(x)).length;
  const meanDvol = dvol.reduce((s, v) => s + v, 0) / T;
  const meanRV = rv.filter(Number.isFinite).reduce((s, v) => s + v, 0) / finiteRV;
  console.log(`meanDVOL=${meanDvol.toFixed(1)} meanRV30=${meanRV.toFixed(1)} finiteRV=${finiteRV}`);
  // implied-realized gap (VRP proxy): mean(dvol - rv)
  let g = 0;
  let gc = 0;
  for (let t = 0; t < T; t++) {
    if (Number.isFinite(rv[t])) {
      g += dvol[t] - rv[t];
      gc++;
    }
  }
  console.log(`mean(DVOL-RV30)=${(g / gc).toFixed(2)} vol-pts (VRP proxy, should be >0)`);
}

main();
