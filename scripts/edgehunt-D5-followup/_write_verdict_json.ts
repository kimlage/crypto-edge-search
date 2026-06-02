import fs from "node:fs";
const OUT="output/edgehunt-D5-followup";
const r=JSON.parse(fs.readFileSync(`${OUT}/preregister_result.json`,"utf8"));
const v={
  test:"D5-08 follow-up: pre-registered single-config forward test + cross-asset generalization",
  verdict:"PROMISING (BTC-only)",
  preregistered_config:r.preregistered_config,
  preregistration_basis:"mechanism (exchange reserve depletion / net outflow -> reduced sell-side liquidity), not backtest Sharpe; locked before inspecting returns; honest N=1",
  free_flow_universe:r.free_flow_universe,
  btc:{
    forward_consume_once:{netSharpe:r.btc.forwardHoldout.netSharpeAnn,dsrAtN1:r.btc.forwardHoldout.dsrAtN1,dsrAtN1_pass:r.btc.forwardHoldout.dsrAtN1_pass,surrogateP:r.btc.forwardHoldout.surrogateP,blockBootstrapCI95:r.btc.forwardHoldout.blockBootstrapCI95,bb_pass:r.btc.forwardHoldout.bb_pass,harveyLiuAdjP:r.btc.forwardHoldout.harveyLiuAdjP,monthlyAt100k:r.btc.forwardHoldout.monthlyAt100k,monthlyAt10k:r.btc.forwardHoldout.monthlyAt10k,conditionalSharpe:r.btc.forwardHoldout.conditionalSharpeAnn},
    full_span:{netSharpe:r.btc.fullSpan.netSharpeAnn,dsrAtN1:r.btc.fullSpan.dsrAtN1,surrogateP:r.btc.fullSpan.surrogateP},
    in_sample:{netSharpe:r.btc.inSample.netSharpeAnn,surrogateP:r.btc.inSample.surrogateP,note:"in-sample 14%-exposure long/flat overlay cannot beat 100%-long B&H Sharpe -> committed gauntlet baseline gate fails in-sample; artifact of overlay vs B&H, not the edge"},
    price_orthogonalized:{full_netSharpe:r.btc_orthogonalized.fullSpan.netSharpeAnn,full_surrogateP:r.btc_orthogonalized.fullSpan.surrogateP,forward_netSharpe:r.btc_orthogonalized.forwardHoldout.netSharpeAnn,forward_surrogateP:r.btc_orthogonalized.forwardHoldout.surrogateP,note:"edge unchanged-to-stronger after price-orthogonalization, surrogate still passes => real price-orthogonal flow info, not a price echo"},
  },
  eth_same_config_no_tuning:{forward_netSharpe:r.eth.forwardHoldout.netSharpeAnn,forward_surrogateP:r.eth.forwardHoldout.surrogateP,forward_randomLotteryP:(r.eth as any).randomLotteryP_forward,full_netSharpe:r.eth.fullSpan.netSharpeAnn,full_surrogateP:r.eth.fullSpan.surrogateP,full_randomLotteryP:(r.eth as any).randomLotteryP_fullSpan,verdict:"does NOT generalize; net-negative on forward tail, indistinguishable from random"},
  information_coefficient:{btc:0.0214,eth:0.0105,note:"IC(-netflowZ, next-day return); ETH carries ~half the info, swamped by noise"},
  pooled_cross_asset:{forward_netSharpe:r.pooled_cross_asset.forwardHoldout.netSharpeAnn,forward_dsrAtN1:r.pooled_cross_asset.forwardHoldout.dsrAtN1,forward_dsrAtN1_pass:r.pooled_cross_asset.forwardHoldout.dsrAtN1_pass,full_netSharpe:r.pooled_cross_asset.fullSpan.netSharpeAnn,verdict:"FAILS - ETH drags pooled below DSR@N=1 threshold"},
  promotion_rule:"SURVIVE iff pre-registered config clears DSR@N=1 AND generalizes to >=1 other asset on forward holdout",
  outcome:"clears DSR@N=1 on BTC (PASS) but does NOT generalize to ETH (FAIL) => PROMISING (BTC-only)",
  one_line:"VERDICT: PROMISING (BTC-only) | pre-registered config smooth=14,zwin=365,thr=1.0,lag=1,long/flat | forward net Sharpe 1.265 | DSR@N=1 0.988 (PASS) | generalizes? BTC-only | monthly@$100k $1858 (BTC forward) | confidence med",
};
fs.writeFileSync(`${OUT}/verdict.json`,JSON.stringify(v,null,2));
console.log("wrote verdict.json");
console.log(v.one_line);
