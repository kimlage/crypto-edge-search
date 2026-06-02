import { readFileSync } from "node:fs";
const ROOT = ".";
interface Bar { date: string; close: number }
const bars: Bar[] = (JSON.parse(readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`,"utf8")) as Bar[]).filter(b=>Number.isFinite(b.close)&&b.close>0);
const dayMs=86400000; const toMs=(d:string)=>Date.parse(`${d}T00:00:00Z`);
const t0=toMs(bars[0].date), tN=toMs(bars[bars.length-1].date);
console.log("data range", bars[0].date, "->", bars[bars.length-1].date);
const HALVINGS=["2016-07-09","2020-05-11","2024-04-20"];
const WIN=547*dayMs;
for(const h of HALVINGS){
  const a=toMs(h); const wEnd=a+WIN;
  // how much of the nominal window is actually covered by data?
  const covStart=Math.max(a,t0); const covEnd=Math.min(wEnd,tN);
  const nominalDays=WIN/dayMs;
  const coveredDays=Math.max(0,(covEnd-covStart)/dayMs);
  console.log(`halving ${h}: window [${new Date(a).toISOString().slice(0,10)} .. ${new Date(wEnd).toISOString().slice(0,10)}], dataCoveredFrac=${(coveredDays/nominalDays).toFixed(3)} (${coveredDays.toFixed(0)}/${nominalDays}d), windowStartsBeforeData=${a<t0}`);
}
