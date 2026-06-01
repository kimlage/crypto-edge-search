/**
 * TRACK D2 — sensitivity: under what configuration (if any) does the carry beat risk-free?
 *
 * The base model showed gross-on-TOTAL-capital ~ 3.8% (3y funding) / 1.7% (current) because the
 * carry only deploys ~50c of notional per $1 of capital (40% idle buffer + 20% perp margin).
 * Here we sweep buffer fraction, perp leverage (margin %), and the funding regime to find the
 * break-even and report honestly whether a real operator can clear the 4.5% hurdle.
 *
 * Reuses output/carry/d2_full_cost_model.json frictions implicitly by recomputing the same
 * cost lines. Run:
 *   node_modules/.bin/tsx scripts/carry/d2_sensitivity.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? path.resolve(__dirname, '../..');
const FUND = path.join(ROOT, 'output/funding');
const CARRY = path.join(ROOT, 'output/carry');

const SURVIVORS = ['BTCUSDT', 'ETHUSDT'] as const;
const RISK_FREE_APR = 4.5;
const FEE_ROUNDTRIP_BPS = 28; // 2*10 spot + 2*4 perp
const HOLD_DAYS = 30;

type FundingPt = { fundingTime: number; fundingRate: number };
const load = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8'));

function fundingApr(sym: string, years: '1y' | '3y'): number {
  const f = load<FundingPt[]>(path.join(FUND, `${sym}_funding_8h.json`));
  const r = f.map((x) => x.fundingRate);
  const slice = years === '1y' ? r.slice(-1095) : r;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  return mean * 3 * 365; // fraction/yr
}

const fund = {
  '1y': SURVIVORS.map((s) => fundingApr(s, '1y')),
  '3y': SURVIVORS.map((s) => fundingApr(s, '3y')),
};

/**
 * For a config, return gross% and net-incremental% on TOTAL capital.
 * - bufferFrac: idle survival buffer (held in T-bills @ RF -> not a drag vs baseline)
 * - perpMarginPct: initial margin posted for the short perp (lower = more leverage = more
 *   notional per $, but more liquidation risk). marginPosted earns 0 -> real opp cost.
 * Capital math: deployable = capital*(1-buffer). Each $1 carry notional needs $1 spot + margin.
 *   cashPerNotional = 1 + perpMarginPct/100 ; carryNotional = deployable / cashPerNotional.
 */
function evalConfig(regime: '1y' | '3y', bufferFrac: number, perpMarginPct: number) {
  const capital = 1; // per-dollar (scale-invariant for % metrics; fixed cost handled separately)
  const buffer = capital * bufferFrac;
  const deployable = capital - buffer;
  const cashPerNotional = 1 + perpMarginPct / 100;
  const carryNotional = deployable / cashPerNotional;
  const perSym = carryNotional / SURVIVORS.length;
  const fr = fund[regime];

  const grossFunding = fr.reduce((a, f) => a + f * perSym, 0); // $/yr on $1 capital
  const roundtripsPerYear = 365 / HOLD_DAYS;
  const fees = (FEE_ROUNDTRIP_BPS / 1e4) * carryNotional * roundtripsPerYear;
  // slippage + rebalancing are tiny at these (we measured <1.5bps/leg up to $1M; ~5bps roundtrip
  // amortized monthly is ~0.05%/yr of notional). Use a conservative blended 8bps/yr of notional.
  const slipAndRebal = (8 / 1e4) * carryNotional;
  const marginOpp = (RISK_FREE_APR / 100) * (perpMarginPct / 100) * carryNotional;
  const opFriction = fees + slipAndRebal + marginOpp;
  // buffer kept in T-bills -> cancels vs baseline. Incremental edge vs all-RF:
  const rfForgoneOnDeployed = (RISK_FREE_APR / 100) * deployable;
  const incrementalEdge = grossFunding - opFriction - rfForgoneOnDeployed;

  return {
    grossPct: grossFunding * 100,
    incrEdgePct: incrementalEdge * 100,
    realisticNetPct: RISK_FREE_APR + incrementalEdge * 100,
    carryNotionalPerDollar: carryNotional,
  };
}

console.log('================ TRACK D2 — SENSITIVITY SWEEP ================');
console.log('Question: does ANY reasonable config clear the 4.5% risk-free hurdle?');
console.log('Metric: incremental edge (%/yr on total capital) of carry vs all-in-T-bills.');
console.log('Positive incr-edge => carry beats risk-free. Negative => just buy T-bills.\n');

for (const regime of ['1y', '3y'] as const) {
  console.log(`--- FUNDING REGIME: ${regime === '1y' ? 'CURRENT (last 12mo)' : 'FAT (3y avg)'} ---`);
  console.log('  buffer\\margin    20%IM(5x)   10%IM(10x)   5%IM(20x)   2%IM(50x)');
  for (const buffer of [0.40, 0.30, 0.20, 0.10, 0.05]) {
    const cells = [20, 10, 5, 2].map((im) => {
      const r = evalConfig(regime, buffer, im);
      const s = (r.incrEdgePct >= 0 ? '+' : '') + r.incrEdgePct.toFixed(2) + '%';
      return s.padStart(10);
    });
    console.log(`   ${(buffer * 100).toFixed(0).padStart(3)}% idle   ` + cells.join('  '));
  }
  console.log('');
}

// Find the funding APR (on notional) needed to break even at the LEANEST sane config
// (10% buffer, 10% IM) and at the conservative base (40% buffer, 20% IM).
function breakevenFundingApr(bufferFrac: number, perpMarginPct: number): number {
  // solve grossFunding(f) - opFriction - rfForgoneOnDeployed = 0 for funding f (same f both syms)
  const buffer = bufferFrac;
  const deployable = 1 - buffer;
  const cashPerNotional = 1 + perpMarginPct / 100;
  const carryNotional = deployable / cashPerNotional;
  const roundtripsPerYear = 365 / HOLD_DAYS;
  const fees = (FEE_ROUNDTRIP_BPS / 1e4) * carryNotional * roundtripsPerYear;
  const slipAndRebal = (8 / 1e4) * carryNotional;
  const marginOpp = (RISK_FREE_APR / 100) * (perpMarginPct / 100) * carryNotional;
  const opFriction = fees + slipAndRebal + marginOpp;
  const rfForgoneOnDeployed = (RISK_FREE_APR / 100) * deployable;
  // grossFunding = f * carryNotional ; need f*carryNotional = opFriction + rfForgoneOnDeployed
  return (opFriction + rfForgoneOnDeployed) / carryNotional * 100; // % APR on notional
}

console.log('BREAK-EVEN funding APR required (on perp notional) to beat risk-free:');
console.log('  base config (40% buffer, 20% IM / 5x): ' + breakevenFundingApr(0.40, 20).toFixed(2) + '% APR funding needed');
console.log('  lean config (10% buffer, 10% IM / 10x): ' + breakevenFundingApr(0.10, 10).toFixed(2) + '% APR funding needed');
console.log('  aggressive   (5% buffer,  5% IM / 20x): ' + breakevenFundingApr(0.05, 5).toFixed(2) + '% APR funding needed');
console.log('');
console.log('Actual funding APR available now (last 12mo): BTC ' + (fund['1y'][0]*100).toFixed(2) + '%, ETH ' + (fund['1y'][1]*100).toFixed(2) + '%');
console.log('Actual funding APR 3y avg:                    BTC ' + (fund['3y'][0]*100).toFixed(2) + '%, ETH ' + (fund['3y'][1]*100).toFixed(2) + '%');

const out = {
  regimes: ['1y', '3y'].map((rg) => ({
    regime: rg,
    grid: [0.40, 0.30, 0.20, 0.10, 0.05].map((buffer) => ({
      bufferFrac: buffer,
      byMargin: [20, 10, 5, 2].map((im) => ({ imPct: im, ...evalConfig(rg as any, buffer, im) })),
    })),
  })),
  breakevenFundingAprNeeded: {
    base_40buf_20im: +breakevenFundingApr(0.40, 20).toFixed(2),
    lean_10buf_10im: +breakevenFundingApr(0.10, 10).toFixed(2),
    aggressive_5buf_5im: +breakevenFundingApr(0.05, 5).toFixed(2),
  },
  actualFundingApr: {
    current1y: { BTC: +(fund['1y'][0] * 100).toFixed(2), ETH: +(fund['1y'][1] * 100).toFixed(2) },
    avg3y: { BTC: +(fund['3y'][0] * 100).toFixed(2), ETH: +(fund['3y'][1] * 100).toFixed(2) },
  },
};
fs.writeFileSync(path.join(CARRY, 'd2_sensitivity.json'), JSON.stringify(out, null, 2));
console.log('\nWrote ' + path.join(CARRY, 'd2_sensitivity.json'));
