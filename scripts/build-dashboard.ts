/**
 * build-dashboard.ts — FRONT: AUDIT-AWARE dashboard
 *
 * Reads the CANONICAL audited results ledger (`output/results-ledger.json`,
 * produced by the Ledger phase / `scripts/build-results-ledger.ts`) as the single
 * source of truth and writes a SINGLE self-contained static `docs/dashboard.html`
 * — vanilla HTML+CSS+JS, no build step, no external dependencies, no CDNs.
 *
 * AUDIT-AWARE contract:
 *   - The FINAL / displayed verdict and ALL headline counts come from the ledger's
 *     `auditedVerdict` (so they equal exactly 0 SURVIVE, 2 PROMISING, rest
 *     KILL/DEFERRED). The dashboard NEVER lets a flipped lead read as a final
 *     PROMISING.
 *   - `rawVerdict` is kept as an honest-provenance column, recovered from the raw
 *     per-domain `output/edgehunt-*\/SUMMARY.md` verdict tables (the same tested
 *     markdown parser this file exposes). Where the raw verdict disagrees with the
 *     audited verdict, the row is VISIBLY FLAGGED ("PROMISING→KILL (audited)").
 *   - The ledger is REQUIRED. If `output/results-ledger.json` is missing we FAIL
 *     LOUDLY rather than silently falling back to the raw tables.
 *
 * Columns: id · domain · name · rawVerdict · auditedVerdict · auditOverrideReason ·
 * lastAudit · ledger source. Search box + domain/verdict filters. Headline counts
 * (SURVIVE / PROMISING / KILL / DEFERRED) are the audited counts.
 *
 * Pure / deterministic: given the same ledger + SUMMARY.md inputs it emits
 * byte-identical HTML (ledger order preserved, no timestamps, no machine paths).
 * The generated HTML embeds only repo-relative paths.
 *
 * NO new dependencies (Node 18+ stdlib only).
 *
 * Run:
 *   tsx scripts/build-dashboard.ts
 *   # or: node_modules/.bin/tsx scripts/build-dashboard.ts
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const OUTPUT_DIR = join(REPO_ROOT, "output");
const LEDGER_PATH = join(OUTPUT_DIR, "results-ledger.json");
const DASHBOARD_PATH = join(REPO_ROOT, "docs", "dashboard.html");

/** The four audited verdict buckets the dashboard filters by. */
export type Verdict = "SURVIVE" | "PROMISING" | "KILL" | "DEFERRED" | "NO VERDICT";

/** A raw verdict-table row recovered from a per-domain SUMMARY.md ledger. */
export interface Row {
  /** Domain code derived from the ledger directory, e.g. "D1", "quant". */
  domain: string;
  /** Hypothesis id, e.g. "D1-03"; "—" when the ledger row has no id column. */
  id: string;
  /** Hypothesis / strategy name. */
  name: string;
  /** Normalized verdict bucket (RAW, per-domain). */
  verdict: Verdict;
  /** Raw verdict cell text as written in the ledger (for honest provenance). */
  verdictRaw: string;
  /** Repo-relative path of the source ledger. */
  source: string;
  /** All remaining table cells joined for full-text search + detail display. */
  detail: string;
}

/**
 * One canonical ledger entry (`output/results-ledger.json`). The dashboard's
 * displayed state is driven entirely by these fields — `rawVerdict` is provenance.
 */
export interface LedgerEntry {
  id: string;
  domain: string;
  name: string;
  claimType?: string;
  rawVerdict: Verdict;
  auditedVerdict: Verdict;
  bindingGate?: string | null;
  honestN?: number | null;
  surrogateP?: number | null;
  monthlyAt100k?: number | null;
  lastAudit: string;
  auditOverrideReason?: string;
  artifactPath?: string;
}

/** A display row: the audited ledger entry enriched with raw-table detail. */
export interface DisplayRow {
  id: string;
  domain: string;
  name: string;
  rawVerdict: Verdict;
  auditedVerdict: Verdict;
  /** True when the audit flipped the lead's verdict (raw != audited). */
  flipped: boolean;
  auditOverrideReason: string;
  lastAudit: string;
  /** Raw-table detail (metrics / binding gate text) for search + display. */
  detail: string;
  /** Repo-relative path of the canonical source artifact. */
  source: string;
}

/** A parsed markdown table: header cells + body rows of cells. */
interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/** Split a markdown table row "| a | b |" into trimmed cell strings. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** True for a markdown table separator row, e.g. "|---|:--:|----|". */
function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s+/g, "")));
}

/** Extract every markdown table (header + separator + body) from a document. */
export function extractTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i];
    const sepLine = lines[i + 1];
    if (!headerLine.trim().startsWith("|")) continue;
    if (!isSeparatorRow(sepLine)) continue;
    const header = splitRow(headerLine);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim().startsWith("|")) break;
      if (isSeparatorRow(line)) continue;
      rows.push(splitRow(line));
    }
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

/** Strip markdown emphasis / inline code so a cell compares cleanly. */
function plain(cell: string): string {
  return cell
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/\\\*/g, "*")
    .trim();
}

const IDENTITY_HEADERS = new Set(["id", "hypothesis", "name", "lead", "thesis", "strategy"]);
const COUNT_HEADERS = new Set(["count", "n"]);

/**
 * Pick the verdict table from a ledger's tables. A verdict table has an exact
 * `verdict` column AND an identity column (id/hypothesis/name/lead/thesis). This
 * excludes the counts tables (e.g. `| Verdict | Count |`, `| Bucket | N |`,
 * `| Outcome | Count | ... |`) which carry verdict *labels* as row values, not
 * per-hypothesis rows, and excludes audit roll-up tables that have no exact
 * `verdict` header.
 */
export function isVerdictTable(table: MarkdownTable): boolean {
  const headers = table.header.map((h) => plain(h).toLowerCase());
  const hasVerdict = headers.includes("verdict");
  const hasIdentity = headers.some((h) => IDENTITY_HEADERS.has(h));
  const isCounts = headers.some((h) => COUNT_HEADERS.has(h)) && !hasIdentity;
  return hasVerdict && hasIdentity && !isCounts;
}

/**
 * Normalize a raw verdict cell to a bucket. Handles bolded tokens, multi-word
 * phrasings ("CONFIRMED PROMISING", "DOWNGRADE-WITHIN-PROMISING", "CONFIRMED
 * KILL"), the "NO VERDICT" sentinel, and a bare em dash. Precedence: SURVIVE >
 * PROMISING > DEFERRED > NO VERDICT > KILL, so a downgrade/confirmation phrase
 * lands in its strongest contained label and only a clean KILL becomes KILL.
 */
export function normalizeVerdict(raw: string): Verdict {
  const t = plain(raw).toUpperCase();
  if (t === "" || t === "—" || t === "-" || t.includes("NO VERDICT")) return "NO VERDICT";
  if (t.includes("SURVIVE")) return "SURVIVE";
  if (t.includes("PROMISING")) return "PROMISING";
  if (t.includes("DEFERRED")) return "DEFERRED";
  if (t.includes("KILL")) return "KILL";
  return "NO VERDICT";
}

/** Derive a human domain code from a ledger directory name. */
export function domainFromDir(dir: string): string {
  const stripped = dir.replace(/^edgehunt-?/, "");
  return stripped === "" ? "consensus" : stripped;
}

/** Find the column index of the first header matching one of `names`. */
function indexOf(headers: string[], names: string[]): number {
  for (const name of names) {
    const idx = headers.indexOf(name);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Parse one ledger file into raw verdict rows. */
export function parseLedger(dir: string, markdown: string): Row[] {
  const domain = domainFromDir(dir);
  const source = `output/${dir}/SUMMARY.md`;
  const rows: Row[] = [];
  for (const table of extractTables(markdown)) {
    if (!isVerdictTable(table)) continue;
    const headers = table.header.map((h) => plain(h).toLowerCase());
    const verdictCol = headers.indexOf("verdict");
    const idCol = indexOf(headers, ["id"]);
    const nameCol = indexOf(headers, ["hypothesis", "name", "lead", "thesis", "strategy"]);
    for (const cells of table.rows) {
      if (cells.length <= verdictCol) continue;
      const verdictRaw = plain(cells[verdictCol] ?? "");
      const verdict = normalizeVerdict(verdictRaw);
      const id = idCol >= 0 ? plain(cells[idCol] ?? "") : "";
      const name = nameCol >= 0 ? plain(cells[nameCol] ?? "") : "";
      // Skip filler/separator rows that carry neither id nor name.
      if (id === "" && name === "" && verdict === "NO VERDICT") continue;
      const detail = cells
        .map((c, i) => (i === verdictCol || i === idCol || i === nameCol ? "" : plain(c)))
        .filter((c) => c !== "")
        .join(" · ");
      rows.push({
        domain,
        id: id === "" ? "—" : id,
        name: name === "" ? "(unnamed)" : name,
        verdict,
        verdictRaw,
        source,
        detail,
      });
    }
  }
  return rows;
}

/** Read every `output/edgehunt-*\/SUMMARY.md` ledger, sorted for determinism. */
export function collectRows(): Row[] {
  const dirs = readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("edgehunt"))
    .map((e) => e.name)
    .sort();
  const rows: Row[] = [];
  for (const dir of dirs) {
    const summaryPath = join(OUTPUT_DIR, dir, "SUMMARY.md");
    let markdown: string;
    try {
      markdown = readFileSync(summaryPath, "utf8");
    } catch {
      continue; // directory has no SUMMARY.md ledger (e.g. VERDICT-only batches)
    }
    rows.push(...parseLedger(dir, markdown));
  }
  return rows;
}

/**
 * Stable synthetic id for the two id-less consensus carries, matching the ledger
 * builder so a raw row's detail can be joined onto its canonical ledger entry.
 */
function stableId(row: Row): string {
  if (row.domain === "consensus") {
    if (/dated-futures/i.test(row.name)) return "D8-C6-DATED";
    if (/VRP/i.test(row.name)) return "VRP-HARVEST";
  }
  return row.id;
}

/** Join key: identity is (domain, stableId). */
function rawKey(domain: string, id: string): string {
  return `${domain} ${id}`;
}

/**
 * Read the CANONICAL audited ledger. The ledger is the single source of truth for
 * the dashboard's displayed verdicts and counts; if it is absent we FAIL LOUDLY
 * rather than silently falling back to the raw per-domain tables.
 */
export function loadLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) {
    throw new Error(
      "output/results-ledger.json is missing — the audited ledger is the canonical source " +
        "of truth for the dashboard. Run the Ledger phase (scripts/build-results-ledger.ts) " +
        "first. Refusing to fall back to raw per-domain verdicts.",
    );
  }
  const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("output/results-ledger.json is not a JSON array of ledger entries.");
  }
  return parsed as LedgerEntry[];
}

/**
 * Build the display rows: the audited ledger drives every row (verdict, counts,
 * flip flag) and the raw per-domain tables only enrich the `detail` column. The
 * `rawVerdict` is taken from the LEDGER (the canonical recorded raw value), so the
 * flip flag and audited state never depend on re-parsing the raw markdown.
 */
export function buildDisplayRows(entries: LedgerEntry[], rawRows: Row[]): DisplayRow[] {
  const detailByKey = new Map<string, string>();
  for (const r of rawRows) {
    const key = rawKey(r.domain, stableId(r));
    // First raw row wins; ledger ids are unique per (domain, id).
    if (!detailByKey.has(key)) detailByKey.set(key, r.detail);
  }

  return entries.map((e) => {
    const flipped = e.rawVerdict !== e.auditedVerdict;
    return {
      id: e.id,
      domain: e.domain,
      name: e.name,
      rawVerdict: e.rawVerdict,
      auditedVerdict: e.auditedVerdict,
      flipped,
      auditOverrideReason: e.auditOverrideReason ?? "",
      lastAudit: e.lastAudit,
      detail: detailByKey.get(rawKey(e.domain, e.id)) ?? "",
      source: e.artifactPath ?? `output/edgehunt-${e.domain}/SUMMARY.md`,
    };
  });
}

/** Count audited verdicts for the headline tally. */
export function auditedCounts(rows: DisplayRow[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    SURVIVE: 0,
    PROMISING: 0,
    KILL: 0,
    DEFERRED: 0,
    "NO VERDICT": 0,
  };
  for (const r of rows) counts[r.auditedVerdict]++;
  return counts;
}

/** HTML-escape a string for safe embedding in text / attribute context. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VERDICT_ORDER: Verdict[] = ["SURVIVE", "PROMISING", "DEFERRED", "KILL", "NO VERDICT"];

/** A short, human flip annotation, e.g. "PROMISING→KILL (audited)". */
export function flipLabel(row: DisplayRow): string {
  return `${row.rawVerdict}→${row.auditedVerdict} (audited)`;
}

/** Render the full self-contained HTML document, driven by the audited ledger. */
export function renderHtml(rows: DisplayRow[]): string {
  const counts = auditedCounts(rows);
  const total = rows.length;
  const flips = rows.filter((r) => r.flipped).length;

  const domains = Array.from(new Set(rows.map((r) => r.domain))).sort();
  const domainOptions = domains
    .map((d) => `      <option value="${esc(d)}">${esc(d)}</option>`)
    .join("\n");

  const tableRows = rows
    .map((r) => {
      const flip = r.flipped ? flipLabel(r) : "";
      const search = esc(
        `${r.domain} ${r.id} ${r.name} ${r.rawVerdict} ${r.auditedVerdict} ${flip} ${r.auditOverrideReason} ${r.detail}`.toLowerCase(),
      );
      // The FINAL verdict cell is the audited verdict. When a lead was flipped we
      // show a prominent "raw→audited (audited)" pill ABOVE the audited badge so a
      // flipped lead can NEVER read as a final PROMISING.
      const auditedCell = r.flipped
        ? `<span class="flip" title="${esc(r.auditOverrideReason)}">${esc(flip)}</span>` +
          `<span class="badge v-${esc(r.auditedVerdict.replace(/ /g, "-"))}">${esc(r.auditedVerdict)}</span>`
        : `<span class="badge v-${esc(r.auditedVerdict.replace(/ /g, "-"))}">${esc(r.auditedVerdict)}</span>`;
      const rawCell = r.flipped
        ? `<span class="badge raw v-${esc(r.rawVerdict.replace(/ /g, "-"))} struck">${esc(r.rawVerdict)}</span>`
        : `<span class="badge raw v-${esc(r.rawVerdict.replace(/ /g, "-"))}">${esc(r.rawVerdict)}</span>`;
      const reasonCell = r.auditOverrideReason
        ? `<span class="reason">${esc(r.auditOverrideReason)}</span>`
        : `<span class="reason muted">—</span>`;
      return `      <tr data-domain="${esc(r.domain)}" data-verdict="${esc(r.auditedVerdict)}" data-flipped="${r.flipped ? "1" : "0"}" data-search="${search}">
        <td class="c-id">${esc(r.id)}</td>
        <td class="c-domain">${esc(r.domain)}</td>
        <td class="c-name">${esc(r.name)}<div class="c-detail">${esc(r.detail)}</div></td>
        <td class="c-rawVerdict">${rawCell}</td>
        <td class="c-auditedVerdict">${auditedCell}</td>
        <td class="c-auditOverrideReason">${reasonCell}</td>
        <td class="c-lastAudit">${esc(r.lastAudit)}</td>
        <td class="c-source"><a href="../${esc(r.source)}">${esc(r.source)}</a></td>
      </tr>`;
    })
    .join("\n");

  // Counts strip: the headline tally is the AUDITED count, computed from the
  // ledger-driven rows (never hardcoded), so it stays honest if the ledger changes.
  const countCards = VERDICT_ORDER.filter((v) => v !== "NO VERDICT")
    .map(
      (v) =>
        `      <div class="count-card cc-${v.replace(/ /g, "-")}"><span class="cc-n">${counts[v]}</span><span class="cc-label">${esc(v)}</span></div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Crypto Edge-Search — Audited Verdict Dashboard</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --border: #262b38; --fg: #e6e8ee;
    --muted: #9aa3b2; --accent: #5b9dff;
    --kill: #ef5350; --promising: #ffb300; --survive: #43a047;
    --deferred: #8e8e93; --noverdict: #4a4f5e; --flip: #ff7043;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header { padding: 24px 24px 8px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
  .banner {
    background: linear-gradient(90deg, rgba(239,83,80,.16), rgba(255,179,0,.12));
    border: 1px solid var(--flip); border-radius: 10px; padding: 12px 16px; margin: 0 0 16px;
    font-size: 14px; font-weight: 600; color: var(--fg);
  }
  .banner .tag { color: var(--flip); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; display: block; margin-bottom: 2px; }
  .counts { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 8px; }
  .count-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 16px; min-width: 96px; display: flex; flex-direction: column;
  }
  .cc-n { font-size: 22px; font-weight: 700; }
  .cc-label { font-size: 11px; letter-spacing: .04em; color: var(--muted); text-transform: uppercase; }
  .cc-SURVIVE .cc-n { color: var(--survive); }
  .cc-PROMISING .cc-n { color: var(--promising); }
  .cc-KILL .cc-n { color: var(--kill); }
  .cc-DEFERRED .cc-n { color: var(--deferred); }
  .cc-total { border-color: var(--accent); }
  .cc-flip { border-color: var(--flip); }
  .cc-flip .cc-n { color: var(--flip); }
  .controls {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    padding: 8px 24px 16px; position: sticky; top: 0; background: var(--bg); z-index: 5;
    border-bottom: 1px solid var(--border);
  }
  input[type="search"], select {
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 10px; font-size: 13px;
  }
  input[type="search"] { min-width: 260px; flex: 1 1 280px; }
  label.flt { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
  #shown { color: var(--muted); font-size: 12px; margin-left: auto; }
  .table-wrap { padding: 0 24px 48px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 980px; }
  thead th {
    text-align: left; font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); padding: 10px 10px; border-bottom: 1px solid var(--border);
    position: sticky; top: 57px; background: var(--bg); cursor: pointer; user-select: none; white-space: nowrap;
  }
  thead th .arrow { color: var(--accent); font-size: 10px; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:hover { background: #1b1f2b; }
  tbody tr[data-flipped="1"] { background: rgba(255,112,67,.06); }
  .c-id { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c-name { font-weight: 600; max-width: 360px; }
  .c-detail { color: var(--muted); font-size: 12px; font-weight: 400; margin-top: 2px; }
  .c-domain { white-space: nowrap; }
  .c-auditOverrideReason { max-width: 420px; }
  .reason { color: var(--muted); font-size: 12px; }
  .reason.muted { color: var(--noverdict); }
  .c-lastAudit { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 12px; }
  .c-source a { color: var(--accent); text-decoration: none; font-size: 12px; white-space: nowrap; }
  .c-source a:hover { text-decoration: underline; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 700; letter-spacing: .03em; white-space: nowrap;
  }
  .badge.raw { opacity: .85; }
  .badge.struck { text-decoration: line-through; opacity: .6; }
  .flip {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 800; letter-spacing: .02em; white-space: nowrap; margin-bottom: 4px;
    background: rgba(255,112,67,.20); color: var(--flip); border: 1px solid var(--flip);
  }
  .v-SURVIVE { background: rgba(67,160,71,.18); color: var(--survive); }
  .v-PROMISING { background: rgba(255,179,0,.18); color: var(--promising); }
  .v-KILL { background: rgba(239,83,80,.16); color: var(--kill); }
  .v-DEFERRED { background: rgba(142,142,147,.18); color: var(--deferred); }
  .v-NO-VERDICT { background: rgba(74,79,94,.30); color: var(--muted); }
  .empty { padding: 32px; text-align: center; color: var(--muted); }
  footer { padding: 0 24px 40px; color: var(--muted); font-size: 12px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Crypto Edge-Search — Audited Verdict Dashboard</h1>
  <p class="sub">~111 trading hypotheses through the committed anti-overfitting gauntlet on free public data at $0 cloud cost. The FINAL verdict and every headline count below come from the canonical audited ledger <code>output/results-ledger.json</code> (not the raw per-domain tables). Each row also shows its RAW per-domain verdict for provenance; where the two-layer audit overturned a lead, the row is flagged.</p>
  <div class="banner">
    <span class="tag">Canonical audited state</span>
    0 SURVIVE · 2 weak PROMISING · rest KILL/DEFERRED — nothing deployable
  </div>
  <div class="counts">
    <div class="count-card cc-total"><span class="cc-n">${total}</span><span class="cc-label">Hypotheses</span></div>
${countCards}
    <div class="count-card cc-flip"><span class="cc-n">${flips}</span><span class="cc-label">Audit flips</span></div>
  </div>
</header>
<div class="controls">
  <input id="q" type="search" placeholder="Search id, name, verdict, override reason…" aria-label="Search" />
  <label class="flt">Domain
    <select id="f-domain">
      <option value="">all</option>
${domainOptions}
    </select>
  </label>
  <label class="flt">Verdict
    <select id="f-verdict">
      <option value="">all (audited)</option>
      <option value="SURVIVE">SURVIVE</option>
      <option value="PROMISING">PROMISING</option>
      <option value="DEFERRED">DEFERRED</option>
      <option value="KILL">KILL</option>
    </select>
  </label>
  <label class="flt"><input id="f-flip" type="checkbox" /> Audit flips only</label>
  <span id="shown"></span>
</div>
<div class="table-wrap">
  <table id="grid">
    <thead>
      <tr>
        <th data-key="id">ID <span class="arrow"></span></th>
        <th data-key="domain">Domain <span class="arrow"></span></th>
        <th data-key="name">Hypothesis <span class="arrow"></span></th>
        <th data-key="rawVerdict">Raw verdict <span class="arrow"></span></th>
        <th data-key="auditedVerdict">Audited verdict (final) <span class="arrow"></span></th>
        <th data-key="auditOverrideReason">Audit override reason <span class="arrow"></span></th>
        <th data-key="lastAudit">Last audit <span class="arrow"></span></th>
        <th data-key="source">Ledger <span class="arrow"></span></th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>
  <div class="empty" id="empty" hidden>No rows match the current filters.</div>
</div>
<footer>
  Built by <code>scripts/build-dashboard.ts</code> from <code>output/results-ledger.json</code> (vanilla, no build step, no external dependencies). The audited verdict is final; a raw per-domain PROMISING that the two-layer audit overturned is shown struck-through with a "raw→audited (audited)" flag and an override reason. A right-null surrogate PASS proves structure is non-random; it does not prove a positive mean at honest N on unseen data — that gap is the PROMISING/SURVIVE boundary, and no lead crossed it.
</footer>
<script>
  (function () {
    var q = document.getElementById("q");
    var fDomain = document.getElementById("f-domain");
    var fVerdict = document.getElementById("f-verdict");
    var fFlip = document.getElementById("f-flip");
    var tbody = document.querySelector("#grid tbody");
    var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
    var shown = document.getElementById("shown");
    var empty = document.getElementById("empty");
    // Verdict rank for sorting: SURVIVE strongest, NO VERDICT weakest.
    var vRank = { "SURVIVE": 0, "PROMISING": 1, "DEFERRED": 2, "KILL": 3, "NO VERDICT": 4 };

    function apply() {
      var term = q.value.trim().toLowerCase();
      var dom = fDomain.value;
      var ver = fVerdict.value;
      var flipOnly = fFlip.checked;
      var n = 0;
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        var ok = true;
        if (dom && tr.getAttribute("data-domain") !== dom) ok = false;
        if (ok && ver && tr.getAttribute("data-verdict") !== ver) ok = false;
        if (ok && flipOnly && tr.getAttribute("data-flipped") !== "1") ok = false;
        if (ok && term && tr.getAttribute("data-search").indexOf(term) === -1) ok = false;
        tr.hidden = !ok;
        if (ok) n++;
      }
      shown.textContent = n + " / " + rows.length + " shown";
      empty.hidden = n !== 0;
    }

    var sortKey = null, sortDir = 1;
    function cellValue(tr, key) {
      if (key === "auditedVerdict") {
        var v = tr.getAttribute("data-verdict");
        return String(vRank[v] !== undefined ? vRank[v] : 9);
      }
      var td = tr.querySelector(".c-" + key);
      return td ? td.textContent.trim().toLowerCase() : "";
    }
    function sortBy(key) {
      if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = 1; }
      rows.sort(function (a, b) {
        var va = cellValue(a, key), vb = cellValue(b, key);
        var na = parseFloat(va), nb = parseFloat(vb);
        var both = !isNaN(na) && !isNaN(nb) && va !== "" && vb !== "";
        var cmp = both ? (na - nb) : va < vb ? -1 : va > vb ? 1 : 0;
        return cmp * sortDir;
      });
      for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
      var ths = document.querySelectorAll("#grid thead th");
      for (var j = 0; j < ths.length; j++) {
        var arrow = ths[j].querySelector(".arrow");
        arrow.textContent = ths[j].getAttribute("data-key") === key ? (sortDir > 0 ? "▲" : "▼") : "";
      }
    }

    q.addEventListener("input", apply);
    fDomain.addEventListener("change", apply);
    fVerdict.addEventListener("change", apply);
    fFlip.addEventListener("change", apply);
    var ths = document.querySelectorAll("#grid thead th");
    for (var k = 0; k < ths.length; k++) {
      (function (th) {
        th.addEventListener("click", function () { sortBy(th.getAttribute("data-key")); });
      })(ths[k]);
    }
    apply();
  })();
</script>
</body>
</html>
`;
}

function main(): void {
  const entries = loadLedger();
  const rawRows = collectRows();
  const rows = buildDisplayRows(entries, rawRows);
  const html = renderHtml(rows);
  writeFileSync(DASHBOARD_PATH, html, "utf8");

  const counts = auditedCounts(rows);
  const flips = rows.filter((r) => r.flipped).length;
  const summary = VERDICT_ORDER.filter((v) => v !== "NO VERDICT")
    .map((v) => `${v}=${counts[v]}`)
    .join("  ");
  console.log(
    `Wrote docs/dashboard.html — ${rows.length} hypotheses from output/results-ledger.json ` +
      `(audited: ${summary}; ${flips} audit flips)`,
  );
}

// Only write the file when run as a script, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
