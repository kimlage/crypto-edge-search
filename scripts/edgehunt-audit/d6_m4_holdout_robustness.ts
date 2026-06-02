/**
 * AUDIT spot-check: is M4's OOS collapse a 60/40-split artifact, or robust?
 * Re-run the IS-pick -> OOS-eval logic at multiple split fractions. If the
 * best-IS config inverts OOS across 50/50, 60/40, 70/30, the KILL is sound
 * (not a single-split regime artifact). Reuses the batch loader.
 */
import { loadPanel, sharpe, annReturn, type PanelRow } from "../edgehunt-D6/load_data";

const COST = 0.0004;
const panel = loadPanel();
const N = panel.length;
const realRet = (i: number) => panel[i].btcRet;

function rollMed(i: number, W: number): number | null {
  const h: number[] = [];
  for (let k = i - W; k < i; k++) { const y = panel[k]?.dfii10; if (y != null) h.push(y); }
  if (h.length < Math.floor(W * 0.6)) return null;
  h.sort((a, b) => a - b);
  return h[Math.floor(h.length / 2)];
}
type Cfg = { id: string; pos: (i: number) => number | null };
function buildConfigs(): Cfg[] {
  const c: Cfg[] = [];
  for (const L of [5, 10, 20, 40, 60]) {
    c.push({ id: `chg-L${L}-LO`, pos: (i) => { const a = panel[i-1]?.dfii10, b = panel[i-1-L]?.dfii10; if (a==null||b==null) return null; return a-b<0?1:0; } });
    c.push({ id: `chg-L${L}-LS`, pos: (i) => { const a = panel[i-1]?.dfii10, b = panel[i-1-L]?.dfii10; if (a==null||b==null) return null; return a-b<0?1:-1; } });
  }
  for (const W of [60, 120, 250]) {
    c.push({ id: `lvl-W${W}-LO`, pos: (i) => { const m=rollMed(i,W); const y=panel[i-1]?.dfii10; if(m==null||y==null)return null; return y<m?1:0; } });
    c.push({ id: `lvl-W${W}-LS`, pos: (i) => { const m=rollMed(i,W); const y=panel[i-1]?.dfii10; if(m==null||y==null)return null; return y<m?1:-1; } });
  }
  return c;
}
function runSplit(cfg: Cfg, lo: number, hi: number) {
  const net: number[] = [], btc: number[] = []; let prev = 0;
  for (let i = Math.max(1, lo); i < hi; i++) {
    const p = cfg.pos(i); if (p == null) continue;
    const r = realRet(i); net.push(p*r - Math.abs(p-prev)*COST); btc.push(r); prev = p;
  }
  return { net, btc };
}
const cfgs = buildConfigs();
for (const frac of [0.5, 0.6, 0.7]) {
  const split = Math.floor(N * frac);
  let bestIs: { cfg: Cfg; s: number } | null = null;
  for (const cfg of cfgs) { const { net } = runSplit(cfg, 1, split); const s = sharpe(net); if (!bestIs || s > bestIs.s) bestIs = { cfg, s }; }
  const oos = runSplit(bestIs!.cfg, split, N);
  console.log(`IS=${(frac*100)|0}% pick=${bestIs!.cfg.id} IS-Sh=${bestIs!.s.toFixed(3)} | OOS-Sh=${sharpe(oos.net).toFixed(3)} OOS-B&H=${sharpe(oos.btc).toFixed(3)} OOS-ret=${(annReturn(oos.net)*100).toFixed(1)}%`);
}
