# Contributing as a quant — add a hypothesis end-to-end

This is the **low-friction path** for a quant who wants to take one trading-technique
hypothesis from idea to honest verdict using the **spec** (JSON schemas), the **CLI**
(`validateStrategy` / `validateStrategyFamily` and the demo runner), and the **8-gate
gauntlet** — without re-reading the whole methodology first.

If you read nothing else, read this:

> **A well-run KILL is a contribution.** You are not expected to find a survivor — across
> ~111 hypotheses, none has cleared the gauntlet to a deployable edge. The product is the
> honest record plus the methodology that produced it.
>
> **The one rule: change the target, never the gates.** You may test any signal, market, or
> data source you like. You may **not** weaken a gate, null, baseline, or cost to let your
> idea through. Gates only ever move toward *more* rigorous.

Term you do not recognize? See [`docs/GLOSSARY.md`](docs/GLOSSARY.md). The deep version of
everything here is [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md); the gates API reference is
[`docs/VALIDATION_HARNESS.md`](docs/VALIDATION_HARNESS.md).

---

## The three things you will touch

| Piece | What it is | Where |
|---|---|---|
| **Spec** | JSON schemas that pin the honest record: the dataset + its biases, the trial ledger (honest N), the cost model, the family-wise surrogate run, each gate, and the final verdict. | [`schemas/`](schemas/) (+ worked examples in [`schemas/examples/`](schemas/examples/)) |
| **CLI** | The one-call gauntlet `validateStrategy(...)`, the searched-grid `validateStrategyFamily(...)`, and a runnable demo. | [`src/lib/validation/`](src/lib/validation/), demo at [`scripts/validation/demo-validate.ts`](scripts/validation/demo-validate.ts) |
| **Gauntlet** | The 8 gates, in one fixed binding order. The first failure is the *binding gate*. | `net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout` |

---

## 0. Setup (≈2 minutes, $0)

```bash
git clone https://github.com/kimlage/crypto-edge-search.git
cd crypto-edge-search
npm install
npm test                 # the committed gates + unit tests — should be green before you start
```

Everything runs on **free, public, key-less data** at **$0** cloud spend. The gates are pure,
deterministic, and seeded.

---

## 1. Pre-register (before you look at returns)

Open a **New hypothesis** issue (`.github/ISSUE_TEMPLATE/new-hypothesis.md`) and fill in all
ten sections. This is not bureaucracy — pre-registration is the only honest way to fix two
things *before* the search can bias them:

- **Honest N** — the number of distinct configs you will try, counted up front (Section 4/5).
- **The right null** — the surrogate that destroys *your* claimed structure (Section 8).

Pre-registering also means a config only counts as `N = 1` if it was frozen from mechanism
**before** you looked at returns — never the argmax of a grid you searched.

---

## 2. Build the strongest honest version

Genuinely try to make it work, then judge it honestly.

- Use a **sound causal signal**; lag every feature `h ≥ 1` (apply the **h=0 leakage gate** —
  report the contemporaneous ceiling, then require the strictly-lagged leg to clear the gates
  *alone*).
- Put your harness/script under the matching `scripts/` directory. **Import the committed gate
  primitives — do not re-implement a gate.**
- If it shows promise, strengthen it (regime conditioning, vol-target, better exits) — and then
  **count every config you tried in honest N**. Strengthening that quietly inflates N is fine;
  hiding it is not.

---

## 3. Run the gauntlet (the CLI)

### Single series — `validateStrategy(...)`

Pass your strategy's **gross** per-period returns plus the honest options. The wrapper charges
cost, carves the holdout *first*, runs all 8 gates, and returns the binding gate.

```ts
import { validateStrategy } from "./src/lib/validation/strategy-validator";

const verdict = validateStrategy(grossReturns, {
  trialCount: 96,                 // HONEST N — every distinct config you searched (not 1, not the argmax)
  statistic: "compoundReturn",    // cost-realistic default
  cost: { takerPerSide: 0.0004, position }, // taker on every |Δposition|
  // For a levered / short book, charge financing on the FULL notional:
  // costModel: DEFAULT_TAKER_MODEL (+ borrow / financing / riskFree), costModelLeverage, costModelPositions
  baselines: { marketReturns, equalWeightReturns, linearReturns },
  surrogate: { iterations: 200, crossSectional: true, panel: { assetReturns } }, // the right null
  holdout: { holdoutFraction: 0.15, testFraction: 0.15, reason: "my-hypothesis" }, // consumed once
  minDeflatedProbability: 0.95,
  seed: "my-hypothesis",
});

console.log(verdict.verdict, verdict.scientificVerdict, "binding:", verdict.bindingGate);
```

`verdict.perGate` carries every gate's `status` (`PASS | FAIL | SKIP | ADVISORY`) and a one-line
`reason`. Run the demo to see it end-to-end on a real series, a noise series (must KILL), and an
AR(1) artifact (the surrogate catches it):

```bash
npx tsx scripts/validation/demo-validate.ts
```

### Searched grid — `validateStrategyFamily(...)`

If you **searched a grid** and kept the best config, the single-best-config surrogate p is a lie
— it ignores every other config you tried. Use the **family-wise MAX-statistic**: rebuild every
config on each surrogate panel, take the grid-max, and compare your real grid-best against that
null. This is the gate that flipped three earlier leads to KILL.

```ts
import { validateStrategyFamily } from "./src/lib/validation/strategy-family-validator";

const fam = validateStrategyFamily(panel, {
  id: "my-family",
  configs,                                   // the FULL grid — honest N = configs.length
  buildReturns: (panel, config) => /* net returns for one config */ [],
  makeSurrogatePanel: (panel, seed) => /* a null that destroys the edge, keeps marginals */ panel,
}, { statistic: "sharpe", iterations: 200, seed: "my-family" });

console.log(fam.passed, "real-best", fam.realBestStat, "surr95", fam.surr95, "familyP", fam.surrogateMaxP);
```

---

## 4. Record the evidence against the spec

Emit the honest record so a stranger can audit it. Each artifact has a schema in
[`schemas/`](schemas/) and a worked example in [`schemas/examples/`](schemas/examples/):

| Artifact | Schema | Pins |
|---|---|---|
| Dataset manifest | `dataset-manifest.schema.json` | source, period, symbols, **known biases**, rate limits |
| Trial ledger | `trial-ledger.schema.json` | every distinct config ⇒ **honest N** is auditable |
| Cost model | `cost-model.schema.json` | taker per side + **financing on full notional** |
| Surrogate run | `surrogate-run.schema.json` | the **family-wise** grid-maxima null + `surr95` |
| Gate | `gate.schema.json` | one gate's `status` + `reason` + `detail` |
| Verdict | `verdict.schema.json` | the aggregate label + the **binding gate** |

Validate your artifacts before you open the PR:

```bash
npm run schema:validate
```

When your hypothesis lands in a per-domain ledger
(`output/edgehunt-*/SUMMARY.md`), regenerate the verdict dashboard so the new row
is searchable/filterable alongside every other hypothesis:

```bash
tsx scripts/build-dashboard.ts   # writes the committed docs/dashboard.html
```

`scripts/build-dashboard.ts` is pure and deterministic — it scans every
committed `output/edgehunt-*/SUMMARY.md` verdict table and rebuilds a single
self-contained, dependency-free [`docs/dashboard.html`](docs/dashboard.html)
(no build step, no CDN, repo-relative links only). Commit the regenerated HTML
in the same PR. (Tip: add `"dashboard": "tsx scripts/build-dashboard.ts"` to
your local `package.json` scripts so it runs as `npm run dashboard`.)

---

## 5. Open the PR

Fill in `.github/PULL_REQUEST_TEMPLATE.md` and confirm, honestly:

- **Change the target, not the gates** — no gate was weakened (if you changed one, it is
  *stricter*, and you re-ran everything).
- **Honest N counted**, **right null** (family-wise for a grid), **financing on full notional**,
  **consume-once holdout**.
- `npm test` green; `npm run typecheck` clean for any `src/` files you touched.

Report the **verdict and the binding gate** with the numbers that produced it. A KILL writeup
should say exactly which gate killed it and why. Most hypotheses KILL — that is expected and
welcome.

---

## The failure modes to expect (so you can name yours up front)

Most leads die one of these deaths. Naming the most likely one in your pre-registration is good
science, not pessimism:

- **Coincident long-beta** — a "trend"/"TA" edge that is just filtered long beta (fails
  `baselines` vs a matched-exposure benchmark).
- **The h=0 tautology** — the edge evaporates once features are lagged `h ≥ 1`.
- **Selection inflation** — a pretty in-sample Sharpe that fails Deflated Sharpe / the haircut at
  honest N (`deflated_sharpe` / `haircut`).
- **Luckiest-of-N** — the grid-best is no better than the best of N structure-less configs
  (`surrogate`, family-wise).
- **Carry sub-risk-free** — a carry that only "works" because financing was under-charged on the
  levered/short notional (`net_of_cost`).
- **Holdout magnitude** — structure is real (surrogate PASS) but the realized mean is
  indistinguishable from zero on the consume-once vault (`holdout`). This is the
  PROMISING/SURVIVE boundary — and no lead has crossed it.

---

*License: MIT — see [`LICENSE`](LICENSE). For the full design rationale, read
[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md); for the broader contribution guide, see
[`CONTRIBUTING.md`](CONTRIBUTING.md).*
