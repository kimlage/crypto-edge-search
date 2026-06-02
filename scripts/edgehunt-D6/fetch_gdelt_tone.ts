/**
 * D6-S5 — Fetch GDELT DOC 2.0 daily tone + article volume for "bitcoin/crypto".
 *
 * Uses the FREE GDELT DOC 2.0 timeline API (no key, no BigQuery):
 *   - mode=timelinetone   -> daily mean tone of matching articles
 *   - mode=timelinevolraw -> raw daily article volume (density)
 *
 * GDELT auto-aggregates to DAILY resolution for spans longer than ~3 months. We chunk the
 * 2023-05 .. 2026-05 window into ~4-month slices to keep responses daily and avoid hour-resolution,
 * with polite backoff (GDELT rate-limits hard: 429 on rapid calls).
 *
 * Output: output/edgehunt-D6/gdelt_tone.json
 *   { query, fetchedAt, daily: [ {date, tone, volume}, ... ] }
 *
 * AVOID heavy fetch: this hits the daily-aggregated timeline endpoint (a handful of calls), NOT raw GKG.
 */
import fs from "node:fs";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-D6/gdelt_tone.json`;
// Match the bitcoin/crypto news universe. Broad OR keeps article density meaningful.
const QUERY = '(bitcoin OR cryptocurrency OR "crypto market")';
const START = "20230501000000";
const END = "20260519000000";

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}
function parseStamp(s: string): Date {
  return new Date(
    Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(8, 10),
      +s.slice(10, 12),
      +s.slice(12, 14),
    ),
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTimeline(
  mode: "timelinetone" | "timelinevolraw",
  startStamp: string,
  endStamp: string,
): Promise<{ date: string; value: number }[]> {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(QUERY)}` +
    `&mode=${mode}&format=json&startdatetime=${startStamp}&enddatetime=${endStamp}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 edgehunt-d6-research/1.0" },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        const wait = Math.min(90000, 15000 * (attempt + 1));
        process.stderr.write(`  ${mode} ${startStamp.slice(0, 8)}: ${res.status}, wait ${wait}ms\n`);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      if (!text.trim().startsWith("{")) {
        lastErr = `non-json (${res.status}): ${text.slice(0, 120)}`;
        await sleep(Math.min(90000, 15000 * (attempt + 1)));
        continue;
      }
      const j = JSON.parse(text);
      const tl = j.timeline?.[0]?.data ?? [];
      const reso = j.query_details?.date_resolution ?? "?";
      process.stderr.write(`  ${mode} ${startStamp.slice(0, 8)}..${endStamp.slice(0, 8)}: ${tl.length} pts (${reso})\n`);
      return tl.map((p: { date: string; value: number }) => ({ date: p.date, value: p.value }));
    } catch (e) {
      lastErr = String(e);
      process.stderr.write(`  ${mode} ${startStamp.slice(0, 8)}: err ${lastErr.slice(0, 60)}\n`);
      await sleep(Math.min(90000, 15000 * (attempt + 1)));
    }
  }
  throw new Error(`fetch failed ${mode} ${startStamp}: ${lastErr}`);
}

// Collapse GDELT timestamps to YYYY-MM-DD and average within day (handles any sub-daily resolution).
function toDailyMean(pts: { date: string; value: number }[]): Map<string, { sum: number; n: number }> {
  const m = new Map<string, { sum: number; n: number }>();
  for (const p of pts) {
    const day = `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`;
    const cur = m.get(day) ?? { sum: 0, n: 0 };
    if (Number.isFinite(p.value)) {
      cur.sum += p.value;
      cur.n += 1;
    }
    m.set(day, cur);
  }
  return m;
}

async function main(): Promise<void> {
  const chunks: [string, string][] = [];
  let cur = parseStamp(START);
  const end = parseStamp(END);
  while (cur < end) {
    const next = new Date(cur);
    next.setUTCMonth(next.getUTCMonth() + 4); // ~4-month chunks -> daily resolution
    const e = next < end ? next : end;
    chunks.push([fmt(cur), fmt(e)]);
    cur = next;
  }
  process.stderr.write(`fetching ${chunks.length} chunks for ${QUERY}\n`);

  const toneDaily = new Map<string, { sum: number; n: number }>();
  const volDaily = new Map<string, { sum: number; n: number }>();

  // resume from checkpoint if present
  const CKPT = `${OUT}.ckpt.json`;
  let doneChunks = 0;
  if (fs.existsSync(CKPT)) {
    const c = JSON.parse(fs.readFileSync(CKPT, "utf8"));
    for (const r of c.tone ?? []) toneDaily.set(r[0], { sum: r[1], n: r[2] });
    for (const r of c.vol ?? []) volDaily.set(r[0], { sum: r[1], n: r[2] });
    doneChunks = c.doneChunks ?? 0;
    process.stderr.write(`resumed from ckpt: ${doneChunks} chunks done\n`);
  }

  const saveCkpt = (done: number) => {
    fs.writeFileSync(
      CKPT,
      JSON.stringify({
        doneChunks: done,
        tone: [...toneDaily].map(([k, v]) => [k, v.sum, v.n]),
        vol: [...volDaily].map(([k, v]) => [k, v.sum, v.n]),
      }),
    );
  };

  for (let i = doneChunks; i < chunks.length; i++) {
    const [s, e] = chunks[i];
    const tone = await fetchTimeline("timelinetone", s, e);
    await sleep(12000);
    const vol = await fetchTimeline("timelinevolraw", s, e);
    await sleep(12000);
    for (const [k, v] of toDailyMean(tone)) {
      const c = toneDaily.get(k) ?? { sum: 0, n: 0 };
      c.sum += v.sum;
      c.n += v.n;
      toneDaily.set(k, c);
    }
    for (const [k, v] of toDailyMean(vol)) {
      const c = volDaily.get(k) ?? { sum: 0, n: 0 };
      c.sum += v.sum;
      c.n += v.n;
      volDaily.set(k, c);
    }
    saveCkpt(i + 1);
  }

  const days = [...new Set([...toneDaily.keys(), ...volDaily.keys()])].sort();
  const daily = days.map((d) => {
    const t = toneDaily.get(d);
    const v = volDaily.get(d);
    return {
      date: d,
      tone: t && t.n > 0 ? t.sum / t.n : null,
      volume: v && v.n > 0 ? v.sum / v.n : null,
    };
  });

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { query: QUERY, source: "GDELT DOC 2.0 timeline API (free)", fetchedAt: new Date().toISOString(), daily },
      null,
      2,
    ),
  );
  const okTone = daily.filter((d) => d.tone != null).length;
  const okVol = daily.filter((d) => d.volume != null).length;
  process.stderr.write(`WROTE ${OUT}: ${daily.length} days, tone=${okTone}, vol=${okVol}, ${days[0]}..${days[days.length - 1]}\n`);
}

main().catch((e) => {
  process.stderr.write(`FATAL ${e}\n`);
  process.exit(1);
});
