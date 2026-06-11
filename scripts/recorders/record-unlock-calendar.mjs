// Campaign-E — unlock-cliff calendar freezer (E3 backbone). SKELETON + working freeze/hash logic.
//
// Pipeline (docs/campaign-E/PREREGISTRATION.md section 3.1):
//   1. Curate the next-12-month cliff list in docs/campaign-E/unlock-calendar-draft.json from the
//      FREE pages (no API key, no payment):
//        - https://cryptorank.io/token-unlocks            (per-token /price/<slug>/vesting pages)
//        - https://tokenomist.ai                          (per-token pages)
//      DefiLlama /emissions is PAYWALLED (HTTP 402, verified 2026-06-09) — historical leg is out
//      of scope; this calendar is forward-only.
//   2. Verify EVERY event against the on-chain vesting contract via a free public RPC
//      (e.g. https://ethereum-rpc.publicnode.com, https://arbitrum-one-rpc.publicnode.com) BEFORE
//      inclusion, and fill the event's verification block (verified=true, contract, method, time).
//   3. Run this script to sha256-freeze the verified events into
//      docs/campaign-E/frozen-calendar-YYYYMMDD.json (append-only: each freeze is a new file).
//
// TODO (best-effort scrape, explicitly deferred): automated scrape selectors for the CryptoRank
// and Tokenomist pages (both render via client-side JS; a fetch of the raw HTML is not enough —
// needs either their free JSON endpoints if stable, or a headless pass). Curation is manual until
// then; the freeze/hash logic below is final and is what the prereg binds to.
//
// Usage:
//   node scripts/recorders/record-unlock-calendar.mjs --check    # validate draft only
//   node scripts/recorders/record-unlock-calendar.mjs            # validate + freeze + hash

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DRAFT = path.join(ROOT, "docs/campaign-E/unlock-calendar-draft.json");
const OUTDIR = path.join(ROOT, "docs/campaign-E");
const LOGDIR = path.join(ROOT, "output/recorders");
mkdirSync(LOGDIR, { recursive: true });

const REQUIRED = ["token", "binancePerpSymbol", "unlockDateUTC", "unlockTimestampUTC", "pctCirculating", "allocation", "cliff", "sourcePages", "verification"];

// Canonical JSON: recursively sort object keys so the hash is layout-independent.
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])]));
  }
  return x;
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

if (!existsSync(DRAFT)) {
  console.error(`[unlock] draft not found: ${DRAFT}`);
  process.exit(1);
}
const draft = JSON.parse(readFileSync(DRAFT, "utf8"));
const events = Array.isArray(draft.events) ? draft.events : [];

const problems = [];
const verified = [];
for (const [i, e] of events.entries()) {
  const missing = REQUIRED.filter((k) => !(k in e));
  if (missing.length) { problems.push(`event[${i}] (${e.token ?? "?"}): missing ${missing.join(",")}`); continue; }
  if (!(e.pctCirculating > 0 && e.pctCirculating < 1)) { problems.push(`event[${i}] ${e.token}: pctCirculating must be a fraction in (0,1)`); continue; }
  if (e.cliff !== true) { problems.push(`event[${i}] ${e.token}: only cliff unlocks are eligible (cliff!==true)`); continue; }
  const v = e.verification ?? {};
  if (v.verified !== true || !v.vestingContract || !v.rpcUrl || !v.verifiedAt) {
    problems.push(`event[${i}] ${e.token}: NOT on-chain verified (verification.verified must be true with vestingContract, rpcUrl, verifiedAt) — EXCLUDED per prereg 3.1`);
    continue;
  }
  verified.push(e);
}

console.error(`[unlock] draft events=${events.length} verified-eligible=${verified.length} problems=${problems.length}`);
for (const p of problems) console.error(`  - ${p}`);

if (process.argv.includes("--check")) process.exit(problems.length && !verified.length ? 1 : 0);

if (verified.length === 0) {
  console.error("[unlock] nothing verified to freeze; curate + verify the draft first. No file written.");
  process.exit(1);
}

// sort deterministically: date then token
verified.sort((a, b) => (a.unlockTimestampUTC + a.token).localeCompare(b.unlockTimestampUTC + b.token));
const canonicalEvents = canonical(verified);
const eventsJson = JSON.stringify(canonicalEvents);
const hash = sha256(eventsJson);
const frozenAt = new Date().toISOString();
const ymd = frozenAt.slice(0, 10).replace(/-/g, "");
const outFile = path.join(OUTDIR, `frozen-calendar-${ymd}.json`);
if (existsSync(outFile)) {
  console.error(`[unlock] ${outFile} already exists — freezes are append-only; refusing to overwrite.`);
  process.exit(1);
}
writeFileSync(outFile, JSON.stringify({
  frozenAt,
  preregRef: "docs/campaign-E/PREREGISTRATION.md#3",
  hashScheme: "sha256 over canonical(sorted-keys) JSON of the events array",
  sha256: hash,
  eventCount: verified.length,
  horizonMonths: 12,
  events: canonicalEvents,
}, null, 2) + "\n");
appendFileSync(path.join(LOGDIR, "unlock-freeze-log.ndjson"),
  JSON.stringify({ frozenAt, file: path.relative(ROOT, outFile), sha256: hash, eventCount: verified.length }) + "\n");
console.error(`[unlock] FROZE ${verified.length} events -> ${outFile}`);
console.error(`[unlock] sha256=${hash}`);
