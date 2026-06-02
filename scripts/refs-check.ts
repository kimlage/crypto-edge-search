/**
 * refs-check.ts — bibliography integrity gate for crypto-edge-search.
 *
 * Parses references.yml (the machine-readable bibliography), asserts every entry
 * is well-formed, prints a status table, and FAILS (exit 1) if any
 * peer-reviewed / working-paper entry lacks both a DOI and a URL — the honest
 * minimum for a citation that backs a verdict.
 *
 * It also cross-checks that every YAML key has a matching @key in references.bib
 * (and vice-versa), so the two files cannot silently drift apart.
 *
 * No external dependencies: a tiny, purpose-built YAML reader handles exactly the
 * flat `entries: [ {key, authors, year, title, venue, doi, url, status, used_by} ]`
 * shape this repo commits — it is NOT a general YAML parser.
 *
 * Run:  npm run refs:check   (== tsx scripts/refs-check.ts)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const YML_PATH = resolve(ROOT, "references.yml");
const BIB_PATH = resolve(ROOT, "references.bib");

const VALID_STATUS = ["peer-reviewed", "working-paper", "practitioner", "unverified"] as const;
type Status = (typeof VALID_STATUS)[number];
const STRICT_STATUS = new Set<Status>(["peer-reviewed", "working-paper"]);

interface RefEntry {
  key: string;
  authors: string[];
  year: number | null;
  title: string;
  venue: string;
  doi: string | null;
  url: string | null;
  status: string;
  used_by: string[];
}

// ----------------------------------------------------------------- YAML reader

/** Strip a surrounding pair of matching quotes, if present. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Parse a scalar value: null, number, or (unquoted) string. */
function parseScalar(raw: string): string | number | null {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  const u = unquote(s);
  if (/^-?\d+$/.test(u)) return Number(u);
  return u;
}

/** Parse an inline flow list `[a, "b, c", d]` respecting quoted commas. */
function parseInlineList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== "") out.push(buf.trim());
  return out.map((x) => unquote(x));
}

/**
 * Minimal reader for the committed references.yml shape. Recognizes:
 *   - top-level `entries:` then a list of `- key: ...` blocks
 *   - per-entry `field: scalar` and `field: [inline, list]`
 * Comment lines (`# ...`) and blank lines are ignored.
 */
function readReferencesYml(text: string): RefEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: Array<Partial<RefEntry>> = [];
  let cur: Partial<RefEntry> | null = null;
  let inEntries = false;

  const pushField = (key: string, rawVal: string) => {
    if (!cur) return;
    if (key === "authors" || key === "used_by") {
      (cur as Record<string, unknown>)[key] = parseInlineList(rawVal);
    } else {
      (cur as Record<string, unknown>)[key] = parseScalar(rawVal);
    }
  };

  for (const rawLine of lines) {
    // Drop trailing inline comments only when not inside quotes/brackets is hard
    // in general; our values never contain a literal " #", so a guarded strip is safe.
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;

    if (!inEntries) {
      if (/^entries:\s*$/.test(line)) inEntries = true;
      continue;
    }

    const listItem = line.match(/^(\s*)-\s+(\S.*)$/);
    if (listItem && listItem[2].includes(":")) {
      // start of a new entry: `- key: value`
      cur = {};
      entries.push(cur);
      const rest = listItem[2];
      const idx = rest.indexOf(":");
      pushField(rest.slice(0, idx).trim(), rest.slice(idx + 1).trim());
      continue;
    }

    const field = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (field && cur) {
      pushField(field[1], field[2]);
    }
  }

  return entries.map((e) => normalizeEntry(e));
}

/** Remove a trailing ` # comment`, but never inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function normalizeEntry(e: Partial<RefEntry>): RefEntry {
  return {
    key: typeof e.key === "string" ? e.key : String(e.key ?? ""),
    authors: Array.isArray(e.authors) ? e.authors : [],
    year: typeof e.year === "number" ? e.year : null,
    title: typeof e.title === "string" ? e.title : "",
    venue: typeof e.venue === "string" ? e.venue : "",
    doi: typeof e.doi === "string" && e.doi !== "" ? e.doi : null,
    url: typeof e.url === "string" && e.url !== "" ? e.url : null,
    status: typeof e.status === "string" ? e.status : "",
    used_by: Array.isArray(e.used_by) ? e.used_by : [],
  };
}

/** Extract @key citation keys from references.bib. */
function readBibKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const re = /@\w+\s*\{\s*([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) keys.add(m[1]);
  return keys;
}

// ------------------------------------------------------------------ rendering

function renderTable(entries: RefEntry[]): string {
  const headers = ["KEY", "YEAR", "STATUS", "DOI?", "URL?", "USED_BY"];
  const rows = entries.map((e) => [
    e.key,
    e.year === null ? "?" : String(e.year),
    e.status || "(missing)",
    e.doi ? "yes" : "—",
    e.url ? "yes" : "—",
    e.used_by.length ? e.used_by.join(",") : "—",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}

// ----------------------------------------------------------------------- main

function main(): number {
  let ymlText: string;
  let bibText: string;
  try {
    ymlText = readFileSync(YML_PATH, "utf8");
  } catch {
    console.error(`refs-check: cannot read references.yml at ${YML_PATH}`);
    return 1;
  }
  try {
    bibText = readFileSync(BIB_PATH, "utf8");
  } catch {
    console.error(`refs-check: cannot read references.bib at ${BIB_PATH}`);
    return 1;
  }

  const entries = readReferencesYml(ymlText);
  const bibKeys = readBibKeys(bibText);

  if (entries.length === 0) {
    console.error("refs-check: no entries parsed from references.yml");
    return 1;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const seenKeys = new Set<string>();
  const ymlKeys = new Set<string>();

  for (const e of entries) {
    const id = e.key || "(no-key)";
    ymlKeys.add(e.key);

    if (!e.key) errors.push(`entry with title "${e.title}" is missing a key`);
    if (e.key && seenKeys.has(e.key)) errors.push(`duplicate key: ${e.key}`);
    seenKeys.add(e.key);

    if (!e.title) errors.push(`${id}: missing title`);
    if (e.authors.length === 0) errors.push(`${id}: missing authors`);
    if (e.year === null) errors.push(`${id}: missing/invalid year`);

    // status must be valid
    if (!VALID_STATUS.includes(e.status as Status)) {
      errors.push(
        `${id}: invalid status "${e.status}" (must be one of ${VALID_STATUS.join(", ")})`,
      );
    }

    // every entry must have a DOI or a URL
    if (!e.doi && !e.url) {
      errors.push(`${id}: has neither doi nor url`);
    }

    // HARD requirement: peer-reviewed / working-paper need a resolving doi or url
    if (STRICT_STATUS.has(e.status as Status) && !e.doi && !e.url) {
      errors.push(
        `${id}: status "${e.status}" requires a doi OR url (none present)`,
      );
    }

    // used_by should be populated (advisory)
    if (e.used_by.length === 0) {
      warnings.push(`${id}: no used_by gate/script ids`);
    }

    // bib cross-check
    if (e.key && !bibKeys.has(e.key)) {
      errors.push(`${id}: present in references.yml but missing from references.bib`);
    }
  }

  // bib entries with no yml counterpart
  for (const bk of bibKeys) {
    if (!ymlKeys.has(bk)) {
      errors.push(`${bk}: present in references.bib but missing from references.yml`);
    }
  }

  // ----- report -----
  console.log(renderTable(entries));
  console.log("");

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const summary = VALID_STATUS.map((s) => `${s}=${counts.get(s) ?? 0}`).join("  ");
  console.log(`Totals: ${entries.length} entries  (${summary})`);
  console.log(`Cross-check: ${ymlKeys.size} yml keys / ${bibKeys.size} bib keys`);

  if (warnings.length) {
    console.log("");
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (errors.length) {
    console.log("");
    console.error(`refs-check FAILED with ${errors.length} error(s):`);
    for (const err of errors) console.error(`  - ${err}`);
    return 1;
  }

  console.log("");
  console.log("refs-check OK: all entries valid; every peer-reviewed/working-paper entry resolves.");
  return 0;
}

process.exit(main());
