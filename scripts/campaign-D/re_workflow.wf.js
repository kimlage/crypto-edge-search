// Campaign-D — FIRST-PRINCIPLES REVERSE-ENGINEERING workflow.
// Launched AFTER the skilled-wallet cohort is proven + profiled. Goal (owner's request): given the
// empirical fingerprint of genuinely-skilled Polymarket traders, infer FROM FIRST PRINCIPLES the
// MECHANISMS by which they make money, and design INDEPENDENT reproduction strategies that rebuild
// the edge from market state alone — NOT by following/copying any wallet. Every hypothesis is
// expressed so it can be falsified through the committed gauntlet on $0 ground-truth data.
//
// Launch: Workflow({ scriptPath: ".../re_workflow.wf.js", args: <cohort_profile.json + proof verdicts> })

export const meta = {
  name: 'polymarket-reverse-engineer',
  description: 'First-principles reverse-engineering of the proven-skilled Polymarket cohort into independent, gauntlet-testable reproduction strategies (no follow-copying)',
  phases: [
    { title: 'Mechanisms', detail: 'mechanism families: WHY the fingerprint pays, grounded in the empirical deltas' },
    { title: 'Merge', detail: 'dedupe into a master RE-hypothesis backlog (RE01..)' },
    { title: 'Critique', detail: 'adversarial right-null / honest-N / failure-mode / $0-feasibility per RE hypothesis' },
    { title: 'Prioritize', detail: 'execute-first set + data each needs' },
  ],
}

const PROFILE = JSON.stringify(args ?? { note: 'no cohort profile passed' });

const CONTEXT = `
You are on a rigorous quant FALSIFICATION LAB reverse-engineering Polymarket prediction markets. We
pulled 172k resolved markets + a 500-market/1.36M-trade tape corpus at $0, and ran the proof phase.
THE KEY FINDING (read the passed args): ranking wallets by past performance does NOT persist — it is
survivorship/variance. Top-decile-train-ROI wallets LOSE money OOS in aggregate (-$90k) and the
copy-surrogate is p=0.528 (no better than random). So "the best traders" are mostly luck + longshot-
premium harvesting, NOT reproducible skill. The persistent-LOOKING sub-cohort's behaviour (selling
cheap longshots, 85% on the eventual winner, ~48h before resolution) is a coherent BEHAVIOURAL LEAD,
but its own calibration test already KILLED on tail risk (holdout mean -1.0).

THE OWNER'S ASK: do NOT propose "follow/copy wallet X" (proven dead). Instead, infer FROM FIRST
PRINCIPLES the MECHANISM each cohort behaviour implies, and design a STANDALONE strategy that
reproduces the edge from MARKET STATE alone (prices, books, resolution rules, time, category) — a
machine could run it without ever seeing any wallet. The honest prior (as in the lab's 111-hypothesis
crypto program: 0 deployable edge) is that MOST of these KILL; the deliverable is the map of where the
edge is NOT, plus any capacity-tiny structural premium that survives. Be ruthless and specific.

GROUND IT IN THE EMPIRICAL FINGERPRINT (cohort MINUS population deltas + profile), passed as JSON:
${PROFILE}
Read the fingerprint literally. Examples of first-principles reading:
 - cohort enters EARLIER (high medianHrsBeforeResolution delta) => primary-liquidity / stale-price /
   information-first edge, not late convergence.
 - cohort buys FAVORITES (high meanEntryPrice) and holds => favorite-settlement carry / theta /
   longshot-bias harvest; reproduce by a price-regime rule, not by copying.
 - high pctOnEventualWinner with LOW scalpRate => directional forecasting skill held to resolution =>
   reproduce via an independent probability estimator vs market price.
 - high scalpRate => intramarket market-making / spread capture => reproduce via a quoting rule.
 - category concentration => domain-information edge => reproduce only where a free signal proxies it.

THE GAUNTLET every RE hypothesis must be designed for (binding order; first failure binds):
  net_of_cost(+spread/financing on full notional) -> baselines(buy&hold + matched-exposure +
  random-lottery + the relevant blind-side base-rate) -> Deflated Sharpe @ HONEST N -> block-bootstrap
  -> CPCV/PBO -> Harvey-Liu haircut -> the RIGHT surrogate null (family-wise MAX for searched grids)
  -> consume-once holdout. Verdicts KILL/PROMISING/SURVIVE/DEFERRED. KILL is the expected, valuable outcome.

NAMED FAILURE MODES to map each hypothesis to: (a) coincident long-beta in disguise; (b) h=0 order-flow
tautology; (c) selection inflation under honest N / single-config surrogate; (d) de-risking as timing;
(e) detection latency; (f) no separable premium over an already-killed parent; (g) reverse-causality
echo; (h) price-clock spurious regression; (i) financing/cost (spread) leak.

HARD CONSTRAINTS: $0 free data only (Gamma metadata+resolution, CLOB prices-history+books, data-api
trades). The strategy must be REPRODUCIBLE from market state and PROVABLE against resolution ground
truth. The most likely honest outcome — as in the 111-hypothesis crypto program — is that the cohort's
"edge" is (i) un-reproducible private information, (ii) survivorship/variance, or (iii) a real but
capacity-tiny structural premium (the prediction-market analogue of carry). Say so when likely.`;

const RE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    hypotheses: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' },
        fingerprint_basis: { type: 'string', description: 'which cohort delta/behaviour this mechanism explains' },
        mechanism: { type: 'string', description: 'the first-principles WHY: the economic/structural reason the edge exists' },
        independent_signal: { type: 'string', description: 'the standalone signal computable from market state (NO wallet-following)' },
        reproduction_strategy: { type: 'string', description: 'concrete rule: entry/exit/sizing from market state' },
        data_needed: { type: 'string' },
        ground_truth_test: { type: 'string', description: 'how resolution makes the verdict measurable' },
        right_null: { type: 'string' },
        honest_n_concern: { type: 'string' },
        likely_failure_mode: { type: 'string' },
        is_reproducible_without_private_info: { type: 'boolean', description: 'false if the edge plausibly requires non-public information' },
        prior_verdict: { type: 'string', enum: ['likely-KILL', 'worth-testing', 'plausible-PROMISING', 'DEFERRED'] },
        provability_1to5: { type: 'integer' },
      },
      required: ['title','fingerprint_basis','mechanism','independent_signal','reproduction_strategy','data_needed','ground_truth_test','right_null','honest_n_concern','likely_failure_mode','is_reproducible_without_private_info','prior_verdict','provability_1to5'],
    } },
  },
  required: ['hypotheses'],
};

const FAMILIES = [
  { key: 'information_forecasting', brief: 'INFORMATION / FORECASTING EDGE held to resolution. If the cohort buys the eventual winner at a discount and holds (high pctOnEventualWinner, low scalpRate), the mechanism is better-than-market probability estimation. Design INDEPENDENT estimators from free signals (base rates, related-market prices, news recency, on-chain for crypto markets) and trade the gap vs market mid. The hard gate: prove the estimator is BETTER-calibrated than the market OOS, not just different.' },
  { key: 'primary_liquidity_stale', brief: 'PRIMARY-LIQUIDITY / STALE-PRICE / NEW-MARKET edge. If the cohort enters EARLY (high hrs-before-resolution, low liquidity), the mechanism is being first to a mispriced fresh market before liquidity/attention arrive. Reproduce with a rule keyed on market age, liquidity, and divergence from a fair anchor — no wallet-following.' },
  { key: 'favorite_settlement_carry', brief: 'FAVORITE-SETTLEMENT CARRY / THETA / LONGSHOT-BIAS HARVEST. If the cohort buys favorites (high meanEntryPrice) and holds to settlement, the mechanism is harvesting the favorite-longshot bias and time-value of near-certain resolution. Reproduce via a pure price-regime rule. Gate hard on the spread + capital lockup + the rare-upset tail.' },
  { key: 'market_making_spread', brief: 'INTRAMARKET MARKET-MAKING / SPREAD CAPTURE. If the cohort scalps (high scalpRate, both sides same market), the mechanism is providing liquidity and earning the spread. Reproduce with a quoting/inventory rule. Gate hard on adverse selection and the h=0 tautology (public prints are post-fill).' },
  { key: 'cross_market_consistency', brief: 'CROSS-MARKET / LOGICAL-CONSISTENCY edge. If skill concentrates where related markets exist, the mechanism may be enforcing consistency (nested dates, mutually-exclusive baskets, complementary events) faster than the crowd. Reproduce via a consistency-arb signal across the live book. Gate on the two-sided spread.' },
  { key: 'resolution_rules_edge', brief: 'RESOLUTION-RULES / SETTLEMENT-MECHANICS edge. If the cohort wins on markets the crowd misreads, the mechanism may be reading the UMA resolution CRITERIA (not the headline question), 50-50 fallback clauses, void conditions, or settlement timing. Reproduce via a rules-aware filter. Note which parts need only free text + resolution ground truth.' },
  { key: 'category_specialist', brief: 'CATEGORY-SPECIALIST DOMAIN edge. If skill is category-concentrated (sports/politics/crypto), the mechanism is domain modelling. Reproduce ONLY where a free external signal proxies the domain (e.g. crypto markets vs on-chain/price; sports vs public odds). Be honest where the edge is private/unscalable.' },
  { key: 'sizing_risk', brief: 'SIZING / RISK-MANAGEMENT edge (the meta-mechanism). Maybe the cohort is not better at picking but better at SIZING (Kelly discipline, avoiding ruin, cutting tails). Reproduce via a sizing overlay on an otherwise-neutral book and test whether sizing ALONE produces positive risk-adjusted edge — or is just lower exposure (failure mode (d)).' },
];

phase('Mechanisms')
const famResults = await parallel(FAMILIES.map((F) => () =>
  agent(
    `${CONTEXT}\n\nYOUR MECHANISM FAMILY: ${F.brief}\n\nPropose the 4-6 strongest INDEPENDENT reproduction hypotheses for this family, each grounded in a ` +
    `specific element of the passed fingerprint. Each must be a standalone strategy (no wallet-following), $0-provable against resolution, ` +
    `with the right null and the honest-N burden named. Flag honestly when the edge likely needs private info (is_reproducible_without_private_info=false). Return JSON via the schema.`,
    { label: `mech:${F.key}`, phase: 'Mechanisms', schema: RE_SCHEMA }
  ).then((r) => ({ family: F.key, hypotheses: r?.hypotheses ?? [] }))
)).then((rs) => rs.filter(Boolean))
const raw = famResults.reduce((n, r) => n + r.hypotheses.length, 0)
log(`Mechanisms produced ${raw} raw RE-hypotheses across ${famResults.length} families`)

phase('Merge')
const MASTER = {
  type: 'object', additionalProperties: false,
  properties: { hypotheses: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'RE01, RE02, ...' }, family: { type: 'string' }, title: { type: 'string' },
      mechanism: { type: 'string' }, independent_signal: { type: 'string' }, reproduction_strategy: { type: 'string' },
      data_needed: { type: 'string' }, ground_truth_test: { type: 'string' }, right_null: { type: 'string' },
      honest_n_concern: { type: 'string' }, likely_failure_mode: { type: 'string' },
      is_reproducible_without_private_info: { type: 'boolean' }, prior_verdict: { type: 'string' }, provability_1to5: { type: 'integer' },
    },
    required: ['id','family','title','mechanism','independent_signal','reproduction_strategy','data_needed','ground_truth_test','right_null','honest_n_concern','likely_failure_mode','is_reproducible_without_private_info','prior_verdict','provability_1to5'],
  } } },
  required: ['hypotheses'],
};
const master = await agent(
  `${CONTEXT}\n\nRaw RE-hypotheses from all mechanism families (JSON):\n${JSON.stringify(famResults)}\n\n` +
  `Merge near-duplicates, drop anything that is really "follow a wallet" or not reproducible from market state, keep the strongest ~20-28, ` +
  `assign ids RE01.. Return the deduped master RE-backlog via the schema.`,
  { label: 'merge:re', phase: 'Merge', schema: MASTER }
)
log(`Merged to ${master.hypotheses.length} RE-hypotheses`)

phase('Critique')
const CRIT = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, sharpened_right_null: { type: 'string' }, honest_n_estimate: { type: 'string' },
    most_likely_binding_gate: { type: 'string', enum: ['net_of_cost','baselines','deflated_sharpe','block_bootstrap','cpcv_pbo','haircut','surrogate','holdout','DEFERRED-data','needs-private-info'] },
    failure_mode_letter: { type: 'string' }, zero_cost_test_recipe: { type: 'string' }, kill_shot: { type: 'string' },
    revised_prior_verdict: { type: 'string', enum: ['likely-KILL','worth-testing','plausible-PROMISING','DEFERRED'] },
  },
  required: ['id','sharpened_right_null','honest_n_estimate','most_likely_binding_gate','failure_mode_letter','zero_cost_test_recipe','kill_shot','revised_prior_verdict'],
};
const critiques = await parallel(master.hypotheses.map((h) => () =>
  agent(`${CONTEXT}\n\nAdversarially critique this RE-hypothesis as the lab's most skeptical methodologist. Find the cheapest measurement that KILLS it, nail the right null, estimate honest N, name the binding gate + failure-mode letter.\n\n${JSON.stringify(h)}\n\nReturn JSON via the schema.`,
    { label: `crit:${h.id}`, phase: 'Critique', schema: CRIT })
)).then((rs) => rs.filter(Boolean))

phase('Prioritize')
const PRIO = {
  type: 'object', additionalProperties: false,
  properties: {
    execute_first: { type: 'array', items: { type: 'string' } }, ranking_rationale: { type: 'string' },
    shared_data_primitives: { type: 'array', items: { type: 'string' } }, cross_cutting_risks: { type: 'string' },
    expected_outcome: { type: 'string' },
  },
  required: ['execute_first','ranking_rationale','shared_data_primitives','cross_cutting_risks','expected_outcome'],
};
const prioritization = await agent(
  `${CONTEXT}\n\nMaster RE-backlog:\n${JSON.stringify(master.hypotheses)}\n\nCritiques:\n${JSON.stringify(critiques)}\n\n` +
  `Produce the execution plan: rank by (provability_at_$0 x reproducibility-without-private-info x informativeness), name the execute-first set (~6-10), the shared datasets needed, cross-cutting risks, and an honest expected outcome. Return JSON via the schema.`,
  { label: 'prioritize:re', phase: 'Prioritize', schema: PRIO }
)

return { master: master.hypotheses, critiques, prioritization, raw, families: famResults.map((r) => ({ family: r.family, n: r.hypotheses.length })) }
