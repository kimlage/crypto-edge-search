import { readFileSync } from "node:fs";
const ROOT = ".";
interface Funding { fundingTime:number; fundingRate:number }
const funding: Funding[] = JSON.parse(readFileSync(`${ROOT}/output/funding/BTCUSDT_funding_8h.json`,"utf8")).sort((a:Funding,b:Funding)=>a.fundingTime-b.fundingTime);
type Bar15=[number,number,number,number,number,number];
const bars: Bar15[] = JSON.parse(readFileSync(`${ROOT}/output/edgehunt-D7/btc_15m_settle_window.json`,"utf8"));
const BAR_MS=15*60000;
// Check: for the best cell h16|follow|lead2|hold8 — entry is lead*bars BEFORE stamp, exit hold*bars after entry.
// stamp at 16:00. lead=2 -> entry at 15:30. exit = entry + 8 bars = 15:30 + 120m = 17:30.
// drift lookback = entry - 4 bars = 14:30 .. 15:30. So drift uses [14:30,15:30], position [15:30,17:30].
// QUESTION: does the exit window (15:30->17:30) STRADDLE the 16:00 stamp? Yes. No look-ahead in drift (all before entry). Good.
// But the funding RATE that determines carry pos is known only AT the stamp. The overlay drift sign uses only pre-entry prices. OK.
// Verify bar timestamps are minute-aligned and the 16:00 UTC stamp maps to a real bar.
let stamp16=0;
for(const f of funding){ if(new Date(f.fundingTime).getUTCHours()===16){ stamp16=f.fundingTime; break; } }
const barByT=new Map<number,number>(); bars.forEach((b,i)=>barByT.set(b[0],i));
const roundToBar=(t:number)=>Math.floor(t/BAR_MS)*BAR_MS;
const stBar=roundToBar(stamp16);
const tEntry=stBar-2*BAR_MS; const tExit=tEntry+8*BAR_MS; const tLook=tEntry-4*BAR_MS;
console.log("sample stamp16 UTC", new Date(stamp16).toISOString());
console.log("stampBar", new Date(stBar).toISOString(), "hasBar", barByT.has(stBar));
console.log("entry", new Date(tEntry).toISOString(), "hasBar", barByT.has(tEntry));
console.log("exit", new Date(tExit).toISOString(), "hasBar", barByT.has(tExit), "-> exit is AFTER the 16:00 stamp:", tExit> stamp16);
console.log("lookStart", new Date(tLook).toISOString(), "hasBar", barByT.has(tLook), "-> lookback all BEFORE entry:", tLook<tEntry && tEntry<=stBar);
// Carry: count fraction positive funding & turnover
let pos=funding.filter(f=>f.fundingRate>0).length, tot=funding.length;
console.log("funding positive frac", (pos/tot).toFixed(3), "of", tot, "stamps");
