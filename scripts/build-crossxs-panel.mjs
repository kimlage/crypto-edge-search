/**
 * EXPERIMENT 1 — Cross-sectional WEEKLY momentum price panel builder.
 *
 * Fetches ~6 years of DAILY klines for a FIXED universe of ~30 liquid USDT pairs
 * from Binance public REST (no auth). Falls back to OKX, then to a CALIBRATED
 * SYNTHETIC panel (clearly labelled) if all networks are blocked.
 *
 * Output (under output/crossxs/):
 *   - daily-closes.json   : { source, generatedAt, symbols, dates, closes[coin][date] }
 *   - weekly-returns.json : coins x weeks matrix of weekly simple returns, ISO-week aligned
 *   - panel-meta.json     : provenance, universe, survivorship note, real-vs-synthetic
 *
 * SURVIVORSHIP BIAS (explicit): the universe is the set of coins that are liquid
 * on Binance TODAY. Coins that delisted / died (e.g. LUNA, FTT) are absent, so any
 * measured edge is an UPPER BOUND. This is stated in panel-meta.json and the audit.
 *
 * Run: PATH=<codex-node-bin>:$PATH node scripts/build-crossxs-panel.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join("output", "crossxs");
mkdirSync(OUT_DIR, { recursive: true });

// FIXED universe of ~30 liquid USDT pairs (current-liquid -> survivorship caveat).
const UNIVERSE = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK",
  "MATIC", "LTC", "TRX", "ATOM", "UNI", "ETC", "XLM", "BCH", "FIL", "APT",
  "NEAR", "ARB", "OP", "INJ", "AAVE", "ALGO", "EGLD", "SAND", "AXS", "GRT",
];

const YEARS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const START_MS = NOW - YEARS * 365 * DAY_MS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- Binance fetch (paginate by startTime) ---------------------------------
async function fetchBinanceDaily(symbol) {
  const pair = `${symbol}USDT`;
  const rows = []; // [openTimeMs, close]
  let cursor = START_MS;
  for (let page = 0; page < 60; page += 1) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d` +
      `&startTime=${cursor}&limit=1000`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`network:${err?.name ?? "err"}`);
    }
    if (res.status === 451 || res.status === 403) throw new Error(`blocked:${res.status}`);
    if (!res.ok) {
      // 400 typically means the symbol does not exist on Binance.
      throw new Error(`http:${res.status}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const k of data) {
      rows.push([Number(k[0]), Number(k[4])]); // openTime, close
    }
    const lastOpen = Number(data[data.length - 1][0]);
    if (data.length < 1000) break;
    cursor = lastOpen + DAY_MS;
    if (cursor > NOW) break;
    await sleep(120); // be polite to the public endpoint
  }
  return rows;
}

// ----- OKX fallback (paginate by `after` = older cursor) ---------------------
async function fetchOkxDaily(symbol) {
  const inst = `${symbol}-USDT`;
  const rows = [];
  let after = NOW; // OKX returns rows OLDER than `after`
  for (let page = 0; page < 60; page += 1) {
    const url =
      `https://www.okx.com/api/v5/market/history-candles?instId=${inst}` +
      `&bar=1D&after=${after}&limit=100`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`network:${err?.name ?? "err"}`);
    }
    if (!res.ok) throw new Error(`http:${res.status}`);
    const body = await res.json();
    if (body.code !== "0" || !Array.isArray(body.data) || body.data.length === 0) break;
    for (const c of body.data) {
      rows.push([Number(c[0]), Number(c[4])]); // ts, close
    }
    const oldest = Number(body.data[body.data.length - 1][0]);
    after = oldest;
    if (oldest <= START_MS) break;
    await sleep(120);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows.filter((r) => r[0] >= START_MS);
}

// ----- Calibrated synthetic panel (fallback only) ----------------------------
// Per-coin GBM with: a shared market factor + idiosyncratic noise + a modest
// cross-sectional momentum autocorrelation (last week's winners keep a small
// edge next week) so the test is MEANINGFUL but not a trivial layup.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function buildSyntheticPanel() {
  const rng = mulberry32(20260531);
  const nDays = YEARS * 365;
  const dates = [];
  for (let d = 0; d < nDays; d += 1) {
    dates.push(new Date(START_MS + d * DAY_MS).toISOString().slice(0, 10));
  }
  const closes = {};
  const price = {};
  const drift = {};
  const momState = {}; // rolling 7-day return per coin -> next-day tilt
  for (const c of UNIVERSE) {
    price[c] = 100 * (0.5 + rng() * 1.5);
    drift[c] = (rng() - 0.5) * 0.0006; // small idiosyncratic drift
    momState[c] = 0;
    closes[c] = [];
  }
  const recent = {}; // window of last 7 daily returns
  for (const c of UNIVERSE) recent[c] = [];

  for (let d = 0; d < nDays; d += 1) {
    const marketShock = gaussian(rng) * 0.025; // shared market factor ~2.5%/day
    for (const c of UNIVERSE) {
      const idio = gaussian(rng) * 0.035; // idiosyncratic ~3.5%/day
      const beta = 0.6 + (hashCode(c) % 80) / 100; // 0.6..1.4
      // modest cross-sectional momentum: 7d trailing return nudges next return
      const trailing = recent[c].reduce((s, x) => s + x, 0);
      const momTilt = 0.06 * trailing; // small persistence coefficient
      const ret = drift[c] + beta * marketShock + idio + momTilt;
      price[c] *= Math.exp(ret - 0.5 * 0.04 * 0.04); // mild Ito correction
      closes[c].push(Number(price[c].toFixed(6)));
      recent[c].push(ret);
      if (recent[c].length > 7) recent[c].shift();
    }
  }
  return { dates, closes, source: "synthetic" };
}
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ----- Align daily closes -> common date grid --------------------------------
function alignToGrid(perCoinRows) {
  // perCoinRows: { coin: [[openMs, close], ...] }
  // Build the union of dates, keep only dates where >= 60% of coins have data,
  // forward-fill small gaps per coin.
  const dateSet = new Set();
  for (const coin of Object.keys(perCoinRows)) {
    for (const [ms] of perCoinRows[coin]) {
      dateSet.add(new Date(ms).toISOString().slice(0, 10));
    }
  }
  const dates = [...dateSet].sort();
  const closes = {};
  for (const coin of Object.keys(perCoinRows)) {
    const map = new Map();
    for (const [ms, close] of perCoinRows[coin]) {
      map.set(new Date(ms).toISOString().slice(0, 10), close);
    }
    const series = [];
    let last = null;
    for (const date of dates) {
      const v = map.get(date);
      if (v !== undefined && Number.isFinite(v) && v > 0) {
        last = v;
        series.push(v);
      } else {
        series.push(last); // forward-fill; null until first real obs
      }
    }
    closes[coin] = series;
  }
  return { dates, closes };
}

// ----- Daily closes -> weekly returns matrix ---------------------------------
function toWeeklyReturns(dates, closes, coins) {
  // ISO week buckets: take the last close of each calendar week (Mon-Sun).
  const weekKey = (iso) => {
    const dt = new Date(iso + "T00:00:00Z");
    const day = (dt.getUTCDay() + 6) % 7; // Mon=0
    const monday = new Date(dt);
    monday.setUTCDate(dt.getUTCDate() - day);
    return monday.toISOString().slice(0, 10);
  };
  const weekOrder = [];
  const lastIdxByWeek = new Map();
  dates.forEach((iso, idx) => {
    const wk = weekKey(iso);
    if (!lastIdxByWeek.has(wk)) weekOrder.push(wk);
    lastIdxByWeek.set(wk, idx); // last index in that week
  });
  const weeks = weekOrder;
  // weekly close per coin = close at the last day index of that week
  const weeklyClose = {};
  for (const coin of coins) {
    weeklyClose[coin] = weeks.map((wk) => closes[coin][lastIdxByWeek.get(wk)]);
  }
  // weekly simple returns (coin x week), null where price missing
  const weeklyRet = {};
  for (const coin of coins) {
    const arr = [];
    for (let i = 1; i < weeks.length; i += 1) {
      const prev = weeklyClose[coin][i - 1];
      const cur = weeklyClose[coin][i];
      if (prev != null && cur != null && prev > 0) arr.push((cur - prev) / prev);
      else arr.push(null);
    }
    weeklyRet[coin] = arr;
  }
  return { weeks: weeks.slice(1), weeklyRet };
}

async function main() {
  console.log("=".repeat(78));
  console.log("EXPERIMENT 1 — building cross-sectional weekly momentum price panel");
  console.log("=".repeat(78));
  console.log(`universe: ${UNIVERSE.length} coins, ~${YEARS}y daily, start=${new Date(START_MS).toISOString().slice(0, 10)}`);

  const perCoin = {};
  const fetched = [];
  const failed = [];
  let source = "binance";
  let blocked = false;

  for (const coin of UNIVERSE) {
    try {
      const rows = await fetchBinanceDaily(coin);
      if (rows.length >= 200) {
        perCoin[coin] = rows;
        fetched.push(coin);
        process.stdout.write(`  ${coin}: ${rows.length} days\n`);
      } else {
        failed.push(`${coin}(thin:${rows.length})`);
      }
    } catch (err) {
      const msg = String(err?.message ?? err);
      failed.push(`${coin}(${msg})`);
      if (msg.startsWith("blocked") || msg.startsWith("network")) {
        blocked = true;
        break;
      }
    }
  }

  // OKX fallback if Binance was blocked entirely
  if (blocked && fetched.length === 0) {
    console.log("\nBinance blocked — trying OKX fallback...");
    source = "okx";
    for (const coin of UNIVERSE) {
      try {
        const rows = await fetchOkxDaily(coin);
        if (rows.length >= 200) {
          perCoin[coin] = rows;
          fetched.push(coin);
          process.stdout.write(`  ${coin}: ${rows.length} days (okx)\n`);
        }
      } catch {
        /* try next */
      }
    }
  }

  let dates;
  let closes;
  let coins;
  let realData;
  let fallbackReason = null;

  if (fetched.length >= 20) {
    const aligned = alignToGrid(perCoin);
    dates = aligned.dates;
    closes = aligned.closes;
    coins = fetched;
    realData = true;
    // trim leading dates where most coins are null to a >=70% coverage start
    console.log(`\nREAL data: ${coins.length} coins via ${source}, ${dates.length} aligned daily dates.`);
  } else {
    fallbackReason = `only ${fetched.length} coins fetched (need >=20); network blocked=${blocked}`;
    console.log(`\nFALLBACK to calibrated SYNTHETIC panel: ${fallbackReason}`);
    const syn = buildSyntheticPanel();
    dates = syn.dates;
    closes = syn.closes;
    coins = UNIVERSE;
    source = "synthetic";
    realData = false;
  }

  const { weeks, weeklyRet } = toWeeklyReturns(dates, closes, coins);

  // coverage per week (fraction of coins with a return)
  const coverage = weeks.map((_, i) => {
    let n = 0;
    for (const c of coins) if (weeklyRet[c][i] != null) n += 1;
    return n / coins.length;
  });
  // keep only weeks with >= 60% coverage (drop the sparse early period)
  const keep = coverage.map((c) => c >= 0.6);
  const keptWeeks = weeks.filter((_, i) => keep[i]);
  const keptRet = {};
  for (const c of coins) keptRet[c] = weeklyRet[c].filter((_, i) => keep[i]);

  const meta = {
    experiment: "crossxs-weekly-momentum",
    source,
    realData,
    fallbackReason,
    generatedAt: new Date().toISOString(),
    universe: coins,
    universeSize: coins.length,
    failedSymbols: failed,
    dailyDates: dates.length,
    weeklyPeriods: keptWeeks.length,
    firstWeek: keptWeeks[0] ?? null,
    lastWeek: keptWeeks[keptWeeks.length - 1] ?? null,
    survivorshipNote:
      "Universe = coins liquid on the exchange TODAY. Dead/delisted coins " +
      "(LUNA, FTT, etc.) are ABSENT, so any measured edge is an UPPER BOUND " +
      "(survivorship-biased). Treat results as best-case.",
    roundTripCostNote: "Audit uses roundTripCost=0.0028 (28 bps) per the cost-realism rule.",
  };

  writeFileSync(join(OUT_DIR, "daily-closes.json"), JSON.stringify({ source, realData, dates, closes }, null, 0));
  writeFileSync(join(OUT_DIR, "weekly-returns.json"), JSON.stringify({ source, realData, weeks: keptWeeks, weeklyRet: keptRet }, null, 0));
  writeFileSync(join(OUT_DIR, "panel-meta.json"), JSON.stringify(meta, null, 2));

  console.log(`\nWeekly panel: ${coins.length} coins x ${keptWeeks.length} weeks (>=60% coverage).`);
  console.log(`Span: ${meta.firstWeek} -> ${meta.lastWeek}`);
  console.log(`Saved -> ${OUT_DIR}/{daily-closes,weekly-returns,panel-meta}.json`);
  console.log(`realData=${realData} source=${source}`);
  console.log("=".repeat(78));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
