/**
 * TRACK OC3 — probe the KEY-GATED sources so we can report honestly whether
 * they are usable at $0 RIGHT NOW. We do NOT have keys, so these are expected
 * to fail with auth errors — we capture the EXACT failure to prove the gate.
 *
 *   - The Graph hosted service (api.thegraph.com)  -> DEPRECATED / shut down
 *   - The Graph decentralized gateway              -> needs API key (free signup,
 *                                                     100k free queries/mo then GRT $)
 *   - Dune Analytics API                            -> needs API key (free signup;
 *                                                     free tier exists but key required)
 *
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-scout/oc3-keyed-probe.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT_DIR = resolve(ROOT, "output/onchain-scout/oc3-defillama");
mkdirSync(OUT_DIR, { recursive: true });

const log = (...a: unknown[]) => console.log(...a);

async function probe(name: string, url: string, init?: RequestInit) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const ms = Date.now() - t0;
    log(`\n[${name}] ${url}`);
    log(`  HTTP ${res.status} ${res.statusText} (${ms}ms)`);
    log(`  body: ${text.slice(0, 220).replace(/\s+/g, " ")}`);
    return { name, url, status: res.status, statusText: res.statusText, ms, body: text.slice(0, 300) };
  } catch (e) {
    log(`\n[${name}] ${url}`);
    log(`  NETWORK ERROR: ${(e as Error).message}`);
    return { name, url, status: 0, statusText: "network-error", ms: Date.now() - t0, body: (e as Error).message };
  }
}

async function main() {
  const results = [];

  // 1. The Graph hosted service (legacy) — expected 301/410 (shut down June 2024).
  results.push(
    await probe("TheGraph-hosted (legacy)", "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
    }),
  );

  // 2. The Graph decentralized gateway — needs API key in URL or Authorization header.
  results.push(
    await probe(
      "TheGraph-decentralized (no key)",
      "https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
      },
    ),
  );

  // 3. Dune API — needs X-Dune-API-Key header; 401 without it.
  results.push(
    await probe("Dune-API (no key)", "https://api.dune.com/api/v1/query/3237025/results?limit=1"),
  );

  const verdict = {
    track: "OC3 key-gated source probes",
    generatedAt: new Date().toISOString(),
    note: "We have NO keys; these probes prove the auth gate. Status codes are the evidence.",
    sources: {
      theGraphHosted: {
        usableAt0Now: false,
        reason: "Hosted service was sunset (June 2024). Endpoint redirects/410 — no data.",
      },
      theGraphDecentralized: {
        usableAt0Now: "needs-free-signup-key",
        reason:
          "Decentralized gateway requires an API key (Authorization header). Free tier ~100k queries/mo, then pay in GRT/USD. NO data without a key.",
      },
      dune: {
        usableAt0Now: "needs-free-signup-key",
        reason:
          "api.dune.com returns 401 without X-Dune-API-Key. Free plan exists (signup) but key is mandatory; free credits are limited.",
      },
    },
    results,
  };
  writeFileSync(resolve(OUT_DIR, "oc3-keyed-probe.json"), JSON.stringify(verdict, null, 2));
  log(`\n=== WROTE ${resolve(OUT_DIR, "oc3-keyed-probe.json")} ===`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

export {};
