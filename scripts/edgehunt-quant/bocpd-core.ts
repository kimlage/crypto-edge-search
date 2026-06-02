/**
 * Q2-BOCPD (D8-A5) — Bayesian Online Change-Point Detection on returns.
 *
 * Strictly online / causal implementation of Adams & MacKay (2007), arXiv:0710.3742.
 * Model: returns r_t ~ Normal(mu, sigma^2) within a regime; conjugate Normal-inverse-Gamma prior on
 * (mu, sigma^2) so the predictive is Student-t. Constant hazard H = 1/lambda (geometric run length).
 *
 * At each step we get:
 *   - P(r_t = 0 | x_{1:t})  : posterior prob the most recent point STARTED a new regime (CP belief)
 *   - E[run length]         : expected run length (long => stable regime, short => recent break)
 *   - the MAP-regime posterior mean (filtered estimate of current-regime mu), causal.
 *
 * Everything uses ONLY data up to and including time t (no look-ahead). The trading rule consumes
 * the run-length posterior AT t to set the position applied to the return r_{t+1} (next bar).
 */

export interface BocpdParams {
  hazardLambda: number; // expected regime length in bars (H = 1/lambda)
  // Normal-inverse-Gamma prior hyperparameters (on standardized returns scale)
  mu0: number;
  kappa0: number; // prior pseudo-count on mean
  alpha0: number; // shape
  beta0: number; // scale
  maxRunLength?: number; // truncate run-length vector for speed
}

export interface BocpdStep {
  cpProb: number; // P(run length == 0 at this step) = change-point belief
  expRunLength: number; // E[run length]
  regimeMean: number; // posterior-mean of mu under MAP run length (current regime mean estimate)
  regimeVar: number; // posterior-mean variance estimate under MAP run length
}

function logStudentTpdf(x: number, mu: number, kappa: number, alpha: number, beta: number): number {
  // predictive for NIG: Student-t with nu = 2*alpha, location mu, scale^2 = beta*(kappa+1)/(alpha*kappa)
  const nu = 2 * alpha;
  const scale2 = (beta * (kappa + 1)) / (alpha * kappa);
  const z = (x - mu) * (x - mu) / scale2;
  // log pdf of student-t
  return (
    lgamma((nu + 1) / 2) -
    lgamma(nu / 2) -
    0.5 * Math.log(nu * Math.PI * scale2) -
    ((nu + 1) / 2) * Math.log(1 + z / nu)
  );
}

function lgamma(x: number): number {
  // Lanczos approximation
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Run BOCPD over a full return series, returning a causal step output for each t (using x_{1:t}).
 * O(T * maxRunLength). Returns array length = returns.length.
 */
export function runBocpd(returns: number[], p: BocpdParams): BocpdStep[] {
  const T = returns.length;
  const H = 1 / p.hazardLambda; // constant hazard
  const Rmax = p.maxRunLength ?? 1000;

  // sufficient-stat arrays indexed by run length r (0..len-1)
  // NIG posterior params as a function of accumulated data within the run
  let mu: number[] = [p.mu0];
  let kappa: number[] = [p.kappa0];
  let alpha: number[] = [p.alpha0];
  let beta: number[] = [p.beta0];
  // run-length posterior R[r]
  let R: number[] = [1.0];

  const out: BocpdStep[] = [];

  for (let t = 0; t < T; t++) {
    const x = returns[t];
    const len = R.length;

    // predictive prob of x under each run-length hypothesis
    const predLog = new Array(len);
    for (let r = 0; r < len; r++) {
      predLog[r] = logStudentTpdf(x, mu[r], kappa[r], alpha[r], beta[r]);
    }

    // growth probabilities: R_new[r+1] = R[r] * pred[r] * (1 - H)
    // changepoint prob:    R_new[0]   = sum_r R[r] * pred[r] * H
    const newLen = Math.min(len + 1, Rmax);
    const Rnew = new Array(newLen).fill(0);
    let cpMass = 0;
    for (let r = 0; r < len; r++) {
      const pr = R[r] * Math.exp(predLog[r]);
      cpMass += pr * H;
      const dest = r + 1;
      if (dest < newLen) Rnew[dest] += pr * (1 - H);
      else if (newLen > 0) Rnew[newLen - 1] += pr * (1 - H); // fold the tail
    }
    Rnew[0] = cpMass;

    // normalize
    let s = 0;
    for (let r = 0; r < newLen; r++) s += Rnew[r];
    if (s <= 0 || !Number.isFinite(s)) {
      // numerical underflow — reset to fresh regime
      for (let r = 0; r < newLen; r++) Rnew[r] = r === 0 ? 1 : 0;
      s = 1;
    } else {
      for (let r = 0; r < newLen; r++) Rnew[r] /= s;
    }

    // update sufficient stats: for run length r at t+1, it is the run length r-1 at t plus x
    const muN = new Array(newLen);
    const kappaN = new Array(newLen);
    const alphaN = new Array(newLen);
    const betaN = new Array(newLen);
    // r = 0 is a fresh regime (prior)
    muN[0] = p.mu0;
    kappaN[0] = p.kappa0;
    alphaN[0] = p.alpha0;
    betaN[0] = p.beta0;
    for (let r = 1; r < newLen; r++) {
      const src = r - 1 < len ? r - 1 : len - 1;
      const k = kappa[src];
      const m = mu[src];
      kappaN[r] = k + 1;
      muN[r] = (k * m + x) / (k + 1);
      alphaN[r] = alpha[src] + 0.5;
      betaN[r] = beta[src] + (k * (x - m) * (x - m)) / (2 * (k + 1));
    }

    // MAP run length
    let mapR = 0;
    let mapP = Rnew[0];
    for (let r = 1; r < newLen; r++) {
      if (Rnew[r] > mapP) {
        mapP = Rnew[r];
        mapR = r;
      }
    }
    // expected run length
    let er = 0;
    for (let r = 0; r < newLen; r++) er += r * Rnew[r];

    out.push({
      cpProb: Rnew[0],
      expRunLength: er,
      regimeMean: muN[mapR],
      regimeVar: betaN[mapR] / Math.max(1e-9, alphaN[mapR] - 1),
    });

    R = Rnew;
    mu = muN;
    kappa = kappaN;
    alpha = alphaN;
    beta = betaN;
  }

  return out;
}
