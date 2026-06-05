# Canonical State — where the verdicts live

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

This project tests trading hypotheses through a committed anti-overfitting gauntlet and
records the outcome of each one. Several documents and one dashboard report those
outcomes. To keep them from drifting apart, there is exactly **one** authoritative source
and a strict precedence order.

## The single source of truth

**`output/results-ledger.json` is the canonical, machine-readable verdict source.**

It is an array of audited entries — one per hypothesis the program ran — conforming to
`schemas/results-ledger.schema.json` (JSON Schema 2020-12). Each entry carries:

- `rawVerdict` — the verdict as written in the per-domain `output/edgehunt-*/SUMMARY.md`
  table, *before* the cross-domain adversarial audit;
- `auditedVerdict` (= the scientific verdict) — the canonical final label after the
  two-layer audit (`output/edgehunt-audit/`, `output/edgehunt-audit-nb/`,
  `output/edgehunt-deepen/`);
- `auditOverrideReason` — **required iff** `rawVerdict != auditedVerdict`, so every flip
  is explained and machine-checkable;
- supporting evidence (`bindingGate`, `honestN`, `surrogateP`, `monthlyAt100k`,
  `lastAudit`, `artifactPath`).

**Audited headline (authoritative): 0 SURVIVE, 2 PROMISING — (1) XS Donchian
channel-position long-short, (2) dated-futures basis carry (unlevered-thin only) — and
everything else KILL or DEFERRED.**

## The human-readable view

**`docs/RESULTS.md` is the human-readable view of the same facts.** It is prose for
people: narrative, caveats, the methodology story, per-lead detail. It must agree with the
ledger. If you only read one file as a human, read `RESULTS.md`; if you need the numbers a
program can check, read the ledger.

## Everything else is derived

- **The dashboard** (`docs/dashboard.html`, built by `scripts/build-dashboard.ts`) and the
  ledger's own parser read the per-domain `SUMMARY.md` tables for the *raw* verdicts; the
  canonical *audited* verdicts and the headline are taken from / asserted against the
  ledger.
- **The consistency check** is `scripts/validate-results-ledger.ts` plus
  `test/results-ledger.test.ts`: they validate `output/results-ledger.json` against the
  schema, enforce the override-reason invariant, and assert the audited headline (0
  SURVIVE, 2 PROMISING). `scripts/build-results-ledger.ts` regenerates the ledger
  deterministically and the test asserts the on-disk file matches byte-for-byte.
- **`docs/BACKLOG.md`** is the research queue; its verdict cells are advisory and tagged
  `[audited: …]` where they were reconciled to the ledger.
- **`docs/CHANGELOG_RESEARCH.md`** is the dated log of audit verdict flips.

## Precedence — the ledger wins

In any conflict over what a hypothesis's verdict *is*, the order is:

1. `output/results-ledger.json` (canonical, machine-readable)
2. `docs/RESULTS.md` (human-readable view — must be reconciled to the ledger)
3. `docs/BACKLOG.md`, `docs/dashboard.html`, per-domain `SUMMARY.md`, AGENTS.md, all other
   prose (advisory; reconcile to the ledger)

If a doc and the ledger disagree, the doc is stale — fix the doc, not the ledger.

## Regenerating and checking

```
tsx scripts/build-results-ledger.ts        # rebuild output/results-ledger.json
tsx scripts/validate-results-ledger.ts     # validate schema + invariants + headline
tsx scripts/validate-schemas.ts            # validate all schemas against their examples
npm test                                   # includes test/results-ledger.test.ts
```
