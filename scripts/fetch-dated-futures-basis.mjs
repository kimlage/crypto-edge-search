/**
 * fetch-dated-futures-basis.mjs — TARGET 8 data fetch (cash-and-carry on dated
 * quarterly futures). Writes ONLY to output/dated-futures/.
 *
 * Binance COIN-margined (dapi) DELIVERY contracts are real dated quarterly
 * futures that expire on the last Friday of Mar/Jun/Sep/Dec and CONVERGE to the
 * index at delivery. Each expired contract's daily klines are retained and
 * fetchable via dapi/v1/klines?symbol=BTCUSD_<YYMMDD>&startTime=... .
 *
 * For each quarterly contract we capture its FULL life up to and including the
 * delivery day (the convergence tail is the whole point of cash-and-carry), plus
 * the aligned spot daily close (BTCUSDT/ETHUSDT on api.binance.com).
 *
 * basis_t = (future_close_t - spot_close_t) / spot_close_t  (contango when > 0).
 * At delivery the future converges to the index so basis -> ~0; a long-spot /
 * short-future position locked at entry harvests the entry basis at convergence.
 *
 * No auth, free public REST. If the network blocks it, the audit falls back to a
 * LABELED synthetic term-structure (ranOnRealData=false) — but this fetch is the
 * preferred path and writes a manifest recording the real source.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";

const OUT = join("output", "dated-futures");
mkdirSync(OUT, { recursive: true });

const DAPI = "https://dapi.binance.com/dapi/v1/klines";
const SPOT = "https://api.binance.com/api/v3/klines";
const DAY = 86_400_000;

// Quarterly expiries (YYMMDD), last Friday of each quarter. We fetch every
// contract whose klines Binance still retains (2021Q4 onward in practice).
const EXPIRIES = [
  "220325", "220624", "220930", "221230",
  "230331", "230630", "230929", "231229",
  "240329", "240628", "240927", "241227",
  "250328", "250627", "250926",
];
const COINS = ["BTC", "ETH"];

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "carry-audit/1.0" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function expiryMs(d) {
  const yy = 2000 + Number(d.slice(0, 2));
  const mm = Number(d.slice(2, 4)) - 1;
  const dd = Number(d.slice(4, 6));
  return Date.UTC(yy, mm, dd, 8, 0, 0); // ~delivery time UTC
}

/** Fetch dapi delivery klines for one contract, paginating forward to capture
 *  the full life through the delivery day. Returns [{date, close}]. */
async function fetchContract(coin, exp) {
  const symbol = `${coin}USD_${exp}`;
  const end = expiryMs(exp) + DAY; // include delivery day
  let start = end - 200 * DAY; // contracts trade ~ up to 9mo but retention caps ~200d
  const rows = new Map();
  for (let page = 0; page < 4; page += 1) {
    const url = `${DAPI}?symbol=${symbol}&interval=1d&limit=200&startTime=${start}&endTime=${end}`;
    const r = await get(url);
    if (r.status !== 200) break;
    let arr;
    try {
      arr = JSON.parse(r.body);
    } catch {
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const k of arr) {
      const date = new Date(k[0]).toISOString().slice(0, 10);
      rows.set(date, Number(k[4]));
    }
    const last = arr[arr.length - 1][0];
    if (arr.length < 200 || last >= end) break;
    start = last + DAY;
    await sleep(120);
  }
  return [...rows.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSpot(coin, firstDate, lastDate) {
  const symbol = `${coin}USDT`;
  const start = Date.parse(firstDate + "T00:00:00Z") - DAY;
  const end = Date.parse(lastDate + "T00:00:00Z") + DAY;
  const out = new Map();
  let cursor = start;
  for (let page = 0; page < 6; page += 1) {
    const url = `${SPOT}?symbol=${symbol}&interval=1d&limit=500&startTime=${cursor}&endTime=${end}`;
    const r = await get(url);
    if (r.status !== 200) break;
    const arr = JSON.parse(r.body);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const k of arr) out.set(new Date(k[0]).toISOString().slice(0, 10), Number(k[4]));
    const last = arr[arr.length - 1][0];
    if (arr.length < 500 || last >= end) break;
    cursor = last + DAY;
    await sleep(120);
  }
  return out;
}

async function main() {
  const manifest = { experiment: "dated-futures-basis", source: null, fetchedAt: new Date().toISOString(), contracts: [] };
  let anyReal = false;

  for (const coin of COINS) {
    const contracts = [];
    for (const exp of EXPIRIES) {
      try {
        const fut = await fetchContract(coin, exp);
        if (fut.length < 20) {
          console.log(`${coin}_${exp}: only ${fut.length} fut rows — skip`);
          continue;
        }
        const spotMap = await fetchSpot(coin, fut[0].date, fut[fut.length - 1].date);
        const aligned = fut
          .map((f) => {
            const spot = spotMap.get(f.date);
            return spot && Number.isFinite(spot) && Number.isFinite(f.close)
              ? { date: f.date, future: f.close, spot, basis: (f.close - spot) / spot }
              : null;
          })
          .filter(Boolean);
        if (aligned.length < 20) {
          console.log(`${coin}_${exp}: only ${aligned.length} aligned rows — skip`);
          continue;
        }
        const expDate = new Date(expiryMs(exp)).toISOString().slice(0, 10);
        contracts.push({ symbol: `${coin}USD_${exp}`, deliveryDate: expDate, rows: aligned });
        anyReal = true;
        const entry = aligned[0];
        const last = aligned[aligned.length - 1];
        console.log(
          `${coin}USD_${exp}: ${aligned.length}d ${entry.date}->${last.date}  entryBasis=${(entry.basis * 100).toFixed(2)}%  exitBasis=${(last.basis * 100).toFixed(3)}%`,
        );
        manifest.contracts.push({
          symbol: `${coin}USD_${exp}`,
          coin,
          deliveryDate: expDate,
          days: aligned.length,
          firstDate: entry.date,
          lastDate: last.date,
          entryBasis: entry.basis,
          exitBasis: last.basis,
        });
      } catch (e) {
        console.log(`${coin}_${exp}: ERR ${e.message}`);
      }
      await sleep(200);
    }
    writeFileSync(join(OUT, `${coin}_quarterly_basis.json`), JSON.stringify(contracts));
  }

  manifest.source = anyReal ? "binance_public_rest_dapi_delivery" : "unavailable";
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest source = ${manifest.source}; ${manifest.contracts.length} contracts written to ${OUT}`);
}

main();
