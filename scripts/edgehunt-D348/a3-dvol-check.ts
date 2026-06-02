/**
 * D3-A3 cross-check: do the GARCH/EGARCH one-step vol forecasts track Deribit DVOL?
 * This validates the "WS (Sharpe)" half of the prior verdict — the vol MODEL is real —
 * which is exactly why the alpha claim fails: good vol forecasting -> smoother beta, not edge.
 * Reuses on-disk output/edgehunt/btc_dvol_daily.json ($0) and a3-forecasts.json.
 */
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
const fc = JSON.parse(fs.readFileSync(path.join(OUT, "a3-forecasts.json"), "utf8")) as {
  date: string;
  garchIV: number;
  egarchIV: number;
  rvIV: number;
}[];
const dvol = JSON.parse(fs.readFileSync(path.join(ROOT, "output/edgehunt/btc_dvol_daily.json"), "utf8")) as {
  date: string;
  close: number;
}[];
const dm = new Map(dvol.map((d) => [d.date, d.close]));
const rows = fc.filter((f) => dm.has(f.date)).map((f) => ({ ...f, dvol: dm.get(f.date) as number }));
function corr(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}
const g = rows.map((r) => r.garchIV);
const e = rows.map((r) => r.egarchIV);
const rv = rows.map((r) => r.rvIV);
const d = rows.map((r) => r.dvol);
const out = {
  overlapDays: rows.length,
  window: rows.length ? [rows[0].date, rows[rows.length - 1].date] : null,
  corr_garchForecast_vs_DVOL: corr(g, d),
  corr_egarchForecast_vs_DVOL: corr(e, d),
  corr_intradayRV_vs_DVOL: corr(rv, d),
  meanGarchIV: g.reduce((x, y) => x + y, 0) / g.length,
  meanDVOL: d.reduce((x, y) => x + y, 0) / d.length,
  note: "DVOL is implied (risk-neutral, includes vol-risk-premium) so it sits above realized; correlation>0.5 confirms the GARCH forecast genuinely tracks forward vol.",
};
fs.writeFileSync(path.join(OUT, "a3-dvol-check.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
