// Campaign-E — prereg hash manifest generator.
// sha256 of docs/campaign-E/PREREGISTRATION.md + every config under docs/campaign-E/configs/
// -> docs/campaign-E/PREREG_HASHES.json (with timestamps).
//
// Re-run after any pre-binding edit; after the binding maintainer commit, a hash change means a
// NEW hypothesis (family count increments) per PREREGISTRATION.md section 5.
//
// Usage: node scripts/recorders/prereg-hash.mjs

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CE = path.join(ROOT, "docs/campaign-E");
const OUT = path.join(CE, "PREREG_HASHES.json");

const targets = [
  path.join(CE, "PREREGISTRATION.md"),
  ...readdirSync(path.join(CE, "configs")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => path.join(CE, "configs", f)),
];

const files = targets.map((p) => {
  const buf = readFileSync(p);
  return {
    path: path.relative(ROOT, p),
    bytes: statSync(p).size,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
});

const manifest = {
  generatedAt: new Date().toISOString(),
  note: "Binding upon maintainer commit (PREREGISTRATION.md section 0). Hash change after binding = new hypothesis, family K increments.",
  files,
};
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.error(`[prereg-hash] wrote ${path.relative(ROOT, OUT)}:`);
for (const f of files) console.error(`  ${f.sha256.slice(0, 16)}…  ${f.bytes.toString().padStart(7)}B  ${f.path}`);
