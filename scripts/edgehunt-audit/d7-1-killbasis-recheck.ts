/**
 * AUDIT re-derivation of the D7.1 KILL basis.
 * Independently confirms:
 *  (1) the chosen 547d variant DSR @ family-N=10 reproduces (0.9427 < 0.95 -> FAIL);
 *  (2) the long-beta-trap gate independently FAILS (captureFrac > 2*dayFrac);
 *  (3) the audit's structural claim "DSR cannot reach 0.95 at the honest EVENT N"
 *      -- recompute DSR with trialCount set to the honest in-sample event count,
 *      and also report the DSR you would need (how high deflatedProb gets) so the
 *      reader can see whether ANY plausible trialCount saves it.
 * Reuses the exact rule from scripts/edgehunt-D7/d7-1-strengthen.ts.
 */
import { readFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
interface Bar { date: string; close: number }
const bars: Bar[] = (
  JSON.parse(readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Bar[]
).filter((b) => Number.isFinite(b.close) && b.close > 0);

const dayMs = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const ANN = Math.sqrt(365);
const COST = 0.0006;

const ret: number[] = [];
const retMs: number[] = [];
for (let i = 1; i < bars.length; i += 1) {
  ret.push(Math.log(bars[i].close / bars[i - 1].close));
  retMs.push(toMs(bars[i].date));
}
const HALVINGS = ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"].map(toMs);
const inW = (ms: number, anchors: number[], winMs: number) =>
  anchors.some((a) => ms >= a && ms < a + winMs);

// chosen variant: 547d, no vol-target
const winMs = 547 * dayMs;
const net: number[] = [];
let prevPos = 0;
let inDays = 0;
for (let i = 0; i < ret.length; i += 1) {
  const pos = inW(retMs[i], HALVINGS, winMs) ? 1 : 0;
  const dpos = Math.abs(pos - prevPos);
  if (pos > 0) inDays += 1;
  net.push(pos * ret[i] - dpos * COST);
  prevPos = pos;
}
const s = summarizeReturnSeries(net);
const sharpeAnn = s.sharpe * ANN;

// long-beta trap
let inSum = 0, inCnt = 0, inTotal = 0;
const bhTotal = ret.reduce((a, b) => a + b, 0);
for (let i = 0; i < ret.length; i += 1) {
  if (inW(retMs[i], HALVINGS, winMs)) { inSum += ret[i]; inCnt += 1; inTotal += ret[i]; }
}
const captureFrac = inTotal / bhTotal;
const dayFrac = inCnt / ret.length;
const longBetaTrapFails = captureFrac >= 2 * dayFrac;

// DSR at several trial counts
const dsrRow = (tc: number) => {
  const d = computeDeflatedSharpeRatio(net, { trialCount: tc });
  return { trialCount: tc, deflatedProbability: d.deflatedProbability, expectedMaxSharpe: d.expectedMaxSharpe };
};

console.log(JSON.stringify({
  chosenVariant: "w547 noVT",
  netSharpeAnnual: sharpeAnn,
  inWindowDays: inDays,
  longBetaTrap: {
    captureFrac, dayFrac, twoDayFrac: 2 * dayFrac,
    gateFails_capture_ge_2dayFrac: longBetaTrapFails,
    captureLeverageVsDays: captureFrac / dayFrac,
  },
  dsr_atFamilyN10: dsrRow(10),
  dsr_atEventN3: dsrRow(3),
  dsr_atEventN2: dsrRow(2),
  dsr_atN1_mostGenerous: dsrRow(1),
  structuralClaim: "even at trialCount=1 (most generous, no multiple-testing penalty) does deflatedProb clear 0.95?",
}, null, 2));
