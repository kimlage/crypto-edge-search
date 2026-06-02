/**
 * D6-TRENDS fetcher: Google Trends weekly "bitcoin" search interest.
 *
 * Google natively returns WEEKLY resolution only for spans < ~5 years. To build a weekly
 * series across 2017-2026 we fetch overlapping ~4-year windows and stitch them by
 * overlap-ratio rescaling (the documented "vintage/rescaled" series — as-revised, NOT PIT).
 * We ALSO fetch the native full-span MONTHLY backbone (clean, single-query, no stitching).
 *
 * Output: output/edgehunt-requeue/gtrends_bitcoin_weekly.json  (stitched weekly)
 *         output/edgehunt-requeue/gtrends_bitcoin_monthly.json (native monthly)
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const COOKIE = "/tmp/gt_cookies.txt";
const OUT = "output/edgehunt-requeue";

function sleep(ms: number) {
  execSync(`python3 -c "import time;time.sleep(${ms / 1000})"`);
}

function curl(url: string, outFile: string): number {
  const cmd = `curl -s -A '${UA}' -b ${COOKIE} -c ${COOKIE} '${url}' -o ${outFile} -w '%{http_code}'`;
  const code = execSync(cmd, { encoding: "utf8" }).trim();
  return Number(code);
}

function stripPrefix(s: string): any {
  return JSON.parse(s.replace(/^\)\]\}'?,?\s*/, ""));
}

interface Pt {
  time: number; // unix seconds (period start)
  value: number;
}

// One explore+multiline round for a given time string. Returns timeline points.
function fetchSeries(timeStr: string, resolutionLabel: string): Pt[] {
  const reqExplore = {
    comparisonItem: [{ keyword: "bitcoin", geo: "", time: timeStr }],
    category: 0,
    property: "",
  };
  const encExplore = encodeURIComponent(JSON.stringify(reqExplore));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = curl(
      `https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encExplore}`,
      "/tmp/gt_e.txt",
    );
    if (code === 429) {
      console.error(`  explore 429 (${timeStr}) attempt ${attempt}; backoff 35s`);
      sleep(35000);
      continue;
    }
    if (code !== 200) {
      console.error(`  explore HTTP ${code} (${timeStr})`);
      sleep(8000);
      continue;
    }
    const raw = fs.readFileSync("/tmp/gt_e.txt", "utf8");
    let j: any;
    try {
      j = stripPrefix(raw);
    } catch {
      console.error(`  explore parse fail (${timeStr})`);
      sleep(8000);
      continue;
    }
    const w = j.widgets.find((x: any) => x.id === "TIMESERIES");
    if (!w) {
      console.error(`  no TIMESERIES widget (${timeStr})`);
      return [];
    }
    const encReq = encodeURIComponent(JSON.stringify(w.request));
    sleep(6000);
    for (let a2 = 0; a2 < 5; a2++) {
      const c2 = curl(
        `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encReq}&token=${w.token}`,
        "/tmp/gt_m.txt",
      );
      if (c2 === 429) {
        console.error(`  multiline 429 (${timeStr}) attempt ${a2}; backoff 35s`);
        sleep(35000);
        continue;
      }
      if (c2 !== 200) {
        console.error(`  multiline HTTP ${c2} (${timeStr})`);
        sleep(8000);
        continue;
      }
      const m = stripPrefix(fs.readFileSync("/tmp/gt_m.txt", "utf8"));
      const td = m.default.timelineData as any[];
      const pts = td
        .filter((d) => d.hasData[0])
        .map((d) => ({ time: Number(d.time), value: Number(d.value[0]) }));
      console.error(`  OK ${timeStr} [${resolutionLabel}] -> ${pts.length} pts`);
      return pts;
    }
    return [];
  }
  return [];
}

// ---- monthly backbone (native, single query, no stitching) ----
console.error("Fetching native MONTHLY full-span backbone...");
const monthly = fetchSeries("2017-01-01 2026-05-18", "MONTH");
fs.writeFileSync(`${OUT}/gtrends_bitcoin_monthly.json`, JSON.stringify(monthly));
sleep(10000);

// ---- weekly windows: 4-year spans with 1-year overlap, stitched by overlap ratio ----
const windows: [string, string][] = [
  ["2017-01-01", "2020-12-31"],
  ["2020-01-01", "2023-12-31"],
  ["2022-06-01", "2026-05-18"],
];
const chunks: Pt[][] = [];
for (const [a, b] of windows) {
  const pts = fetchSeries(`${a} ${b}`, "WEEK");
  chunks.push(pts);
  sleep(12000);
}

// Stitch: anchor chunk0 as-is. For each subsequent chunk, compute ratio over overlap region
// (median of ratio chunkPrev/chunkCur on shared weeks) and rescale current chunk onto prev scale.
function stitch(chunks: Pt[][]): Pt[] {
  if (chunks.length === 0) return [];
  const out = new Map<number, number>();
  for (const p of chunks[0]) out.set(p.time, p.value);
  for (let i = 1; i < chunks.length; i++) {
    const cur = chunks[i];
    const curMap = new Map(cur.map((p) => [p.time, p.value]));
    const ratios: number[] = [];
    for (const p of cur) {
      if (out.has(p.time) && p.value > 0 && out.get(p.time)! > 0) {
        ratios.push(out.get(p.time)! / p.value);
      }
    }
    ratios.sort((x, y) => x - y);
    const scale = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
    console.error(`  stitch chunk ${i}: overlap=${ratios.length} scale=${scale.toFixed(4)}`);
    for (const p of cur) {
      if (!out.has(p.time)) out.set(p.time, p.value * scale);
    }
  }
  const arr = [...out.entries()].map(([time, value]) => ({ time, value }));
  arr.sort((a, b) => a.time - b.time);
  return arr;
}
const weekly = stitch(chunks);
fs.writeFileSync(`${OUT}/gtrends_bitcoin_weekly.json`, JSON.stringify(weekly));
console.error(
  `DONE: monthly=${monthly.length} weekly=${weekly.length} ` +
    `weeklyRange=${weekly.length ? new Date(weekly[0].time * 1000).toISOString().slice(0, 10) : "-"}..` +
    `${weekly.length ? new Date(weekly[weekly.length - 1].time * 1000).toISOString().slice(0, 10) : "-"}`,
);
