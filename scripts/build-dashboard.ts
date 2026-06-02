/**
 * build-dashboard.ts — FRONT: dashboard
 *
 * Scans the committed per-domain result ledgers (`output/edgehunt-*\/SUMMARY.md`),
 * extracts every markdown verdict-table row (id | name/hypothesis | verdict | ...),
 * and writes a SINGLE self-contained static `docs/dashboard.html` — vanilla
 * HTML+CSS+JS, no build step, no external dependencies, no CDNs. The page has a
 * search box, filters by domain and by verdict (KILL / PROMISING / SURVIVE /
 * DEFERRED), one big sortable table, and headline counts.
 *
 * Pure / deterministic: given the same SUMMARY.md inputs it emits byte-identical
 * HTML (ledgers are sorted, rows preserve ledger order, no timestamps, no machine
 * paths). The generated HTML embeds only repo-relative paths.
 *
 * NO new dependencies (Node 18+ stdlib only).
 *
 * Run:
 *   tsx scripts/build-dashboard.ts
 *   # or: node_modules/.bin/tsx scripts/build-dashboard.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const OUTPUT_DIR = join(REPO_ROOT, "output");
const DASHBOARD_PATH = join(REPO_ROOT, "docs", "dashboard.html");

/** The four verdict buckets the dashboard filters by, plus a residual bucket. */
type Verdict = "SURVIVE" | "PROMISING" | "KILL" | "DEFERRED" | "NO VERDICT";

export interface Row {
  /** Domain code derived from the ledger directory, e.g. "D1", "quant". */
  domain: string;
  /** Hypothesis id, e.g. "D1-03"; "—" when the ledger row has no id column. */
  id: string;
  /** Hypothesis / strategy name. */
  name: string;
  /** Normalized verdict bucket. */
  verdict: Verdict;
  /** Raw verdict cell text as written in the ledger (for honest provenance). */
  verdictRaw: string;
  /** Repo-relative path of the source ledger. */
  source: string;
  /** All remaining table cells joined for full-text search + detail display. */
  detail: string;
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

/** Parse one ledger file into verdict rows. */
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

/** Render the full self-contained HTML document. */
export function renderHtml(rows: Row[]): string {
  const counts: Record<string, number> = {};
  for (const v of VERDICT_ORDER) counts[v] = 0;
  for (const r of rows) counts[r.verdict] += 1;
  const total = rows.length;

  const domains = Array.from(new Set(rows.map((r) => r.domain))).sort();

  const domainOptions = domains
    .map((d) => `      <option value="${esc(d)}">${esc(d)}</option>`)
    .join("\n");

  const tableRows = rows
    .map((r) => {
      const search = esc(
        `${r.domain} ${r.id} ${r.name} ${r.verdict} ${r.verdictRaw} ${r.detail}`.toLowerCase(),
      );
      return `      <tr data-domain="${esc(r.domain)}" data-verdict="${esc(r.verdict)}" data-search="${search}">
        <td class="c-domain">${esc(r.domain)}</td>
        <td class="c-id">${esc(r.id)}</td>
        <td class="c-name">${esc(r.name)}</td>
        <td class="c-verdict"><span class="badge v-${esc(r.verdict.replace(/ /g, "-"))}">${esc(r.verdict)}</span></td>
        <td class="c-detail">${esc(r.detail)}</td>
        <td class="c-source"><a href="../${esc(r.source)}">${esc(r.source)}</a></td>
      </tr>`;
    })
    .join("\n");

  // Counts strip: headline tally. Values are computed from the parsed ledgers,
  // not hardcoded, so the page stays honest if the ledgers change.
  const countCards = VERDICT_ORDER.map(
    (v) =>
      `      <div class="count-card cc-${v.replace(/ /g, "-")}"><span class="cc-n">${counts[v]}</span><span class="cc-label">${esc(v)}</span></div>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Crypto Edge-Search — Verdict Dashboard</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --border: #262b38; --fg: #e6e8ee;
    --muted: #9aa3b2; --accent: #5b9dff;
    --kill: #ef5350; --promising: #ffb300; --survive: #43a047;
    --deferred: #8e8e93; --noverdict: #4a4f5e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header { padding: 24px 24px 8px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
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
  table { border-collapse: collapse; width: 100%; min-width: 880px; }
  thead th {
    text-align: left; font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); padding: 10px 10px; border-bottom: 1px solid var(--border);
    position: sticky; top: 57px; background: var(--bg); cursor: pointer; user-select: none; white-space: nowrap;
  }
  thead th .arrow { color: var(--accent); font-size: 10px; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:hover { background: #1b1f2b; }
  .c-id { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c-name { font-weight: 600; }
  .c-detail { color: var(--muted); font-size: 12.5px; max-width: 520px; }
  .c-domain { white-space: nowrap; }
  .c-source a { color: var(--accent); text-decoration: none; font-size: 12px; white-space: nowrap; }
  .c-source a:hover { text-decoration: underline; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 700; letter-spacing: .03em; white-space: nowrap;
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
  <h1>Crypto Edge-Search — Verdict Dashboard</h1>
  <p class="sub">~111 trading hypotheses through the committed anti-overfitting gauntlet on free public data at $0 cloud cost. 0 SURVIVE · 2 weak PROMISING · the rest KILL. Generated from the committed <code>output/edgehunt-*/SUMMARY.md</code> ledgers — nothing here is deployable.</p>
  <div class="counts">
    <div class="count-card cc-total"><span class="cc-n">${total}</span><span class="cc-label">Rows</span></div>
${countCards}
  </div>
</header>
<div class="controls">
  <input id="q" type="search" placeholder="Search id, name, verdict, binding gate…" aria-label="Search" />
  <label class="flt">Domain
    <select id="f-domain">
      <option value="">all</option>
${domainOptions}
    </select>
  </label>
  <label class="flt">Verdict
    <select id="f-verdict">
      <option value="">all</option>
      <option value="SURVIVE">SURVIVE</option>
      <option value="PROMISING">PROMISING</option>
      <option value="DEFERRED">DEFERRED</option>
      <option value="KILL">KILL</option>
      <option value="NO VERDICT">NO VERDICT</option>
    </select>
  </label>
  <span id="shown"></span>
</div>
<div class="table-wrap">
  <table id="grid">
    <thead>
      <tr>
        <th data-key="domain">Domain <span class="arrow"></span></th>
        <th data-key="id">ID <span class="arrow"></span></th>
        <th data-key="name">Hypothesis <span class="arrow"></span></th>
        <th data-key="verdict">Verdict <span class="arrow"></span></th>
        <th data-key="detail">Detail <span class="arrow"></span></th>
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
  Built by <code>scripts/build-dashboard.ts</code> (vanilla, no build step, no external dependencies). Each row links to its source ledger. A right-null surrogate PASS proves structure is non-random; it does not prove a positive mean at honest N on unseen data — that gap is the PROMISING/SURVIVE boundary, and no lead crossed it.
</footer>
<script>
  (function () {
    var q = document.getElementById("q");
    var fDomain = document.getElementById("f-domain");
    var fVerdict = document.getElementById("f-verdict");
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
      var n = 0;
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        var ok = true;
        if (dom && tr.getAttribute("data-domain") !== dom) ok = false;
        if (ok && ver && tr.getAttribute("data-verdict") !== ver) ok = false;
        if (ok && term && tr.getAttribute("data-search").indexOf(term) === -1) ok = false;
        tr.hidden = !ok;
        if (ok) n++;
      }
      shown.textContent = n + " / " + rows.length + " shown";
      empty.hidden = n !== 0;
    }

    var sortKey = null, sortDir = 1;
    function cellValue(tr, key) {
      if (key === "verdict") {
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
  const rows = collectRows();
  const html = renderHtml(rows);
  writeFileSync(DASHBOARD_PATH, html, "utf8");
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const summary = VERDICT_ORDER.map((v) => `${v}=${counts[v] ?? 0}`).join("  ");
  console.log(`Wrote docs/dashboard.html — ${rows.length} rows  (${summary})`);
}

// Only write the file when run as a script, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
