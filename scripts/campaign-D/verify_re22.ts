/**
 * Campaign-D — committed re-derivation of the RE22 keystone (the audit flagged the 0.792/+0.0001
 * numbers as having no machine-readable trace and contradicting the RE agent's erroneous 0.889).
 * Question: is the cohort's high on-winner rate forecasting SKILL, or mechanical given their prices?
 * price-tied Bernoulli null: under calibration P(on winner) = price if BUY, (1-price) if SELL.
 * Emits output/campaign-D/re22.json.
 *
 * Run: npx tsx scripts/campaign-D/verify_re22.ts
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
type Mkt = { id: string; window: "train" | "oos"; winnerIndex: number };
const markets: Mkt[] = readFileSync(`${DIR}/copy-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cohort = new Set<string>(existsSync(`${DIR}/cohort_profile.json`) ? JSON.parse(readFileSync(`${DIR}/cohort_profile.json`, "utf8")).cohortWallets.map((w: any) => w.w) : []);
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
type T = { w: string; s: "BUY" | "SELL"; oi: number; p: number; sz: number };
const trades = (id: string): T[] => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

// eligibility (mirror the persistence test) for the "all eligible" group
const cnt = new Map<string, [number, number]>();
for (const m of markets) { if (!cached.has(m.id)) continue; for (const t of trades(m.id)) { const c = cnt.get(t.w) ?? [0, 0]; c[m.window === "train" ? 0 : 1]++; cnt.set(t.w, c); } }
const elig = new Set([...cnt.entries()].filter(([, c]) => c[0] >= 15 && c[1] >= 3).map(([w]) => w));

function evalGroup(filter: ((w: string) => boolean) | null) {
  let obs = 0, nullExp = 0, n = 0;
  for (const m of markets) {
    if (!cached.has(m.id)) continue;
    for (const t of trades(m.id)) {
      if (filter && !filter(t.w)) continue;
      if (!(t.p > 0 && t.p < 1)) continue;
      const onWin = (t.s === "BUY") === (t.oi === m.winnerIndex);
      const pnull = t.s === "BUY" ? t.p : 1 - t.p;
      obs += onWin ? 1 : 0; nullExp += pnull; n++;
    }
  }
  return { n, observed_onWinner: +(obs / n).toFixed(4), priceTied_null: +(nullExp / n).toFixed(4), gap: +((obs - nullExp) / n).toFixed(4) };
}
const out = {
  note: "observed pctOnWinner vs price-tied Bernoulli null. gap>0 => above price regime (survivorship for the selected cohort); ~0 => calibrated/no forecasting skill.",
  cohort_97: evalGroup((w) => cohort.has(w)),
  all_eligible: evalGroup((w) => elig.has(w)),
  entire_corpus: evalGroup(null),
};
writeFileSync(`${DIR}/re22.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
