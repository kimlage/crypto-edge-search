// Campaign-D — pinned-snapshot manifest for reproducibility parity (the audit flagged live-API data
// with no hash). Records sha256 + row counts of the cached datasets, the resolution base rate, and the
// months that hit the Gamma 10k/month offset cap (recency-truncation: latest-closing markets dropped
// because the fetch uses &order=endDate&ascending=true).
//
// Usage: node scripts/campaign-D/manifest.mjs   ->  output/campaign-D/SNAPSHOT.json

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
const DIR = "output/campaign-D";
const sha = (f) => existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) : null;
const lines = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length : 0;

// per-endDate-month counts of the resolved snapshot to flag truncated months
const monthCount = {}; let total = 0, binClean = 0, yes = 0;
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
for (const line of (existsSync(`${DIR}/resolved-markets.jsonl`) ? readFileSync(`${DIR}/resolved-markets.jsonl`, "utf8").split("\n") : [])) {
  if (!line.trim()) continue; total++;
  const m = JSON.parse(line); const ym = (m.endDate || "").slice(0, 7); if (ym) monthCount[ym] = (monthCount[ym] || 0) + 1;
  const outs = parse(m.outcomes), ops = parse(m.outcomePrices);
  if (outs && outs.length === 2 && new Set(outs.map((o) => String(o).toLowerCase())).size === 2 && [...outs.map((o)=>o.toLowerCase())].includes("yes") && ops && ops.length === 2) {
    const yi = outs.findIndex((o) => String(o).toLowerCase() === "yes");
    const a = Math.round(Number(ops[yi])), b = Math.round(Number(ops[1 - yi]));
    if ((a === 1 && b === 0) || (a === 0 && b === 1)) { binClean++; if (a === 1) yes++; }
  }
}
const truncated = Object.entries(monthCount).filter(([, c]) => c >= 9900).map(([ym, c]) => ({ month: ym, count: c })).sort((x, y) => x.month.localeCompare(y.month));
const files = ["resolved-markets.jsonl", "copy-markets.jsonl", "calib-markets.jsonl", "calibration.jsonl"];
const out = {
  note: "Pinned snapshot manifest. Data is from FREE Gamma/CLOB/data-api endpoints; re-fetching later yields DIFFERENT markets (new resolutions), so these hashes pin the exact analysis corpus.",
  generated_marker: "stamp at commit time; do not use Date.now in-script",
  files: Object.fromEntries(files.map((f) => [f, { rows: lines(`${DIR}/${f}`), sha256_16: sha(`${DIR}/${f}`), bytes: existsSync(`${DIR}/${f}`) ? statSync(`${DIR}/${f}`).size : 0 }])),
  resolved_corpus: { total, binary_clean_resolved: binClean, yes: yes, base_rate_yes: +(yes / Math.max(1, binClean)).toFixed(3) },
  truncated_months_at_10k_cap: truncated,
  truncation_bias: "Months at the 10k cap drop the LATEST-closing markets within the month (ascending endDate order) — a recency-truncation bias to disclose.",
};
writeFileSync(`${DIR}/SNAPSHOT.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, files: Object.keys(out.files) }, null, 2));
console.log("truncated months:", truncated.length);
