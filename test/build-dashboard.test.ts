import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditedCounts,
  buildDisplayRows,
  collectRows,
  domainFromDir,
  extractTables,
  flipLabel,
  isVerdictTable,
  loadLedger,
  normalizeVerdict,
  parseLedger,
  renderHtml,
  splitRow,
  type DisplayRow,
  type LedgerEntry,
  type Row,
} from "../scripts/build-dashboard";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const LEDGER_PATH = join(REPO_ROOT, "output", "results-ledger.json");

/** The committed canonical ledger — the dashboard's single source of truth. */
const committedLedger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerEntry[];

// ---------------------------------------------------------------------------
// Raw markdown parsing (provenance layer) — unchanged behavior.
// ---------------------------------------------------------------------------

describe("splitRow", () => {
  it("trims pipe-delimited cells and drops the leading/trailing pipe", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
    expect(splitRow("x | y")).toEqual(["x", "y"]);
  });
});

describe("extractTables", () => {
  it("parses a header + separator + body block and skips prose", () => {
    const md = [
      "intro prose",
      "",
      "| ID | Verdict |",
      "|---|---|",
      "| A1 | KILL |",
      "| A2 | **PROMISING** |",
      "",
      "more prose",
    ].join("\n");
    const tables = extractTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0].header).toEqual(["ID", "Verdict"]);
    expect(tables[0].rows).toEqual([
      ["A1", "KILL"],
      ["A2", "**PROMISING**"],
    ]);
  });
});

describe("isVerdictTable", () => {
  it("accepts a table with a Verdict column and an identity column", () => {
    expect(isVerdictTable({ header: ["ID", "Hypothesis", "Verdict"], rows: [] })).toBe(true);
    expect(isVerdictTable({ header: ["Lead", "Verdict", "Net Sharpe"], rows: [] })).toBe(true);
  });

  it("rejects the counts tables (Verdict|Count, Bucket|N, Outcome|Count)", () => {
    expect(isVerdictTable({ header: ["Verdict", "Count"], rows: [] })).toBe(false);
    expect(isVerdictTable({ header: ["Bucket", "N"], rows: [] })).toBe(false);
    expect(isVerdictTable({ header: ["Outcome", "Count", "Hypotheses"], rows: [] })).toBe(false);
  });

  it("rejects audit roll-up tables that lack an exact Verdict header", () => {
    expect(
      isVerdictTable({ header: ["Batch", "Audit verdict", "Verifier verdict", "Synthesis"], rows: [] }),
    ).toBe(false);
  });
});

describe("normalizeVerdict", () => {
  it("normalizes the literal ledger spellings into the four buckets", () => {
    expect(normalizeVerdict("KILL")).toBe("KILL");
    expect(normalizeVerdict("**KILL**")).toBe("KILL");
    expect(normalizeVerdict("**PROMISING**")).toBe("PROMISING");
    expect(normalizeVerdict("DEFERRED")).toBe("DEFERRED");
    expect(normalizeVerdict("CONFIRMED PROMISING")).toBe("PROMISING");
    expect(normalizeVerdict("CONFIRMED KILL")).toBe("KILL");
    expect(normalizeVerdict("DOWNGRADE-WITHIN-PROMISING")).toBe("PROMISING");
  });

  it("maps the no-verdict sentinels and bare dashes to NO VERDICT", () => {
    expect(normalizeVerdict("NO VERDICT")).toBe("NO VERDICT");
    expect(normalizeVerdict("**NO VERDICT**")).toBe("NO VERDICT");
    expect(normalizeVerdict("—")).toBe("NO VERDICT");
    expect(normalizeVerdict("")).toBe("NO VERDICT");
  });
});

describe("domainFromDir", () => {
  it("strips the edgehunt prefix and maps the bare ledger to consensus", () => {
    expect(domainFromDir("edgehunt-D1")).toBe("D1");
    expect(domainFromDir("edgehunt-quant")).toBe("quant");
    expect(domainFromDir("edgehunt-audit-nb")).toBe("audit-nb");
    expect(domainFromDir("edgehunt")).toBe("consensus");
  });
});

describe("parseLedger", () => {
  const md = [
    "# Demo",
    "",
    "## Counts",
    "| Verdict | Count |",
    "|---|---|",
    "| KILL | 2 |",
    "| PROMISING | 1 |",
    "",
    "## Verdict table",
    "| ID | Hypothesis | Verdict | Net Sharpe |",
    "|---|---|---|---|",
    "| X-01 | Some trend overlay | **KILL** | 1.64 |",
    "| X-02 | A real-looking carry | **PROMISING** | 0.99 |",
    "| — | 3 further slots | **NO VERDICT** | — |",
  ].join("\n");

  it("reads only the verdict table, not the counts table", () => {
    const rows = parseLedger("edgehunt-X", md);
    expect(rows.map((r) => r.id)).toEqual(["X-01", "X-02", "—"]);
    expect(rows.map((r) => r.verdict)).toEqual(["KILL", "PROMISING", "NO VERDICT"]);
  });

  it("attaches the domain, name, repo-relative source, and detail", () => {
    const rows = parseLedger("edgehunt-X", md);
    const first = rows[0] as Row;
    expect(first.domain).toBe("X");
    expect(first.name).toBe("Some trend overlay");
    expect(first.source).toBe("output/edgehunt-X/SUMMARY.md");
    expect(first.detail).toContain("1.64");
  });
});

// ---------------------------------------------------------------------------
// Audit-aware display layer — driven by output/results-ledger.json.
// ---------------------------------------------------------------------------

/** A tiny synthetic ledger that mirrors the canonical shape (1 flip, 1 clean). */
const fixture: LedgerEntry[] = [
  {
    id: "D8-C6-DATED",
    domain: "consensus",
    name: "Dated-futures basis carry (unlevered, thin)",
    rawVerdict: "PROMISING",
    auditedVerdict: "PROMISING",
    lastAudit: "2026-06-01",
    artifactPath: "output/edgehunt-deepen/SUMMARY.md",
  },
  {
    id: "D5-08",
    domain: "D5",
    name: "Exchange reserve/netflow trend",
    rawVerdict: "PROMISING",
    auditedVerdict: "KILL",
    lastAudit: "2026-06-01",
    auditOverrideReason: "family-wise surrogate fails under the MAX-statistic null",
    artifactPath: "output/edgehunt-audit/SUMMARY.md",
  },
  {
    id: "D1-03",
    domain: "D1",
    name: "Supertrend overlay",
    rawVerdict: "KILL",
    auditedVerdict: "KILL",
    lastAudit: "2026-06-01",
    artifactPath: "output/edgehunt-D1/SUMMARY.md",
  },
];

describe("buildDisplayRows", () => {
  it("flags exactly the rows where rawVerdict != auditedVerdict", () => {
    const rows = buildDisplayRows(fixture, []);
    const flipped = rows.filter((r) => r.flipped);
    expect(flipped.map((r) => r.id)).toEqual(["D5-08"]);
    expect(flipLabel(flipped[0])).toBe("PROMISING→KILL (audited)");
  });

  it("carries the audited verdict, raw verdict, override reason and lastAudit through", () => {
    const rows = buildDisplayRows(fixture, []);
    const dated = rows.find((r) => r.id === "D8-C6-DATED") as DisplayRow;
    expect(dated.auditedVerdict).toBe("PROMISING");
    expect(dated.rawVerdict).toBe("PROMISING");
    expect(dated.flipped).toBe(false);
    expect(dated.lastAudit).toBe("2026-06-01");
  });

  it("enriches the detail column from a matching raw per-domain row", () => {
    const raw: Row[] = [
      {
        domain: "D1",
        id: "D1-03",
        name: "Supertrend overlay",
        verdict: "KILL",
        verdictRaw: "KILL",
        source: "output/edgehunt-D1/SUMMARY.md",
        detail: "DSR 0.21 @N=40",
      },
    ];
    const rows = buildDisplayRows(fixture, raw);
    expect((rows.find((r) => r.id === "D1-03") as DisplayRow).detail).toBe("DSR 0.21 @N=40");
  });
});

describe("auditedCounts", () => {
  it("counts the AUDITED (final) verdict, not the raw verdict", () => {
    const counts = auditedCounts(buildDisplayRows(fixture, []));
    // The flipped D5-08 is counted as KILL, not as a PROMISING.
    expect(counts.PROMISING).toBe(1);
    expect(counts.KILL).toBe(2);
    expect(counts.SURVIVE).toBe(0);
  });
});

describe("renderHtml (audit-aware)", () => {
  it("emits a self-contained document with the canonical audited banner", () => {
    const html = renderHtml(buildDisplayRows(fixture, []));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<table");
    expect(html).toContain(
      "0 SURVIVE · 1 weak PROMISING · rest KILL/DEFERRED — nothing deployable",
    );
  });

  it("has the audit-aware columns", () => {
    const html = renderHtml(buildDisplayRows(fixture, []));
    for (const key of [
      "id",
      "domain",
      "name",
      "rawVerdict",
      "auditedVerdict",
      "auditOverrideReason",
      "lastAudit",
    ]) {
      expect(html).toContain(`data-key="${key}"`);
    }
  });

  it("renders a flipped lead with an explicit raw→audited flag and never as a final PROMISING", () => {
    const html = renderHtml(buildDisplayRows(fixture, []));
    expect(html).toContain("PROMISING→KILL (audited)");
    // The flipped row's data-verdict (the FINAL/filterable verdict) is KILL.
    const flippedRow = html
      .split("\n")
      .find((line) => line.includes('data-search') && line.includes("reserve"));
    expect(flippedRow).toBeDefined();
    expect(flippedRow as string).toContain('data-verdict="KILL"');
    expect(flippedRow as string).toContain('data-flipped="1"');
  });

  it("keeps the search box and the domain + verdict filters", () => {
    const html = renderHtml(buildDisplayRows(fixture, []));
    expect(html).toMatch(/<input id="q" type="search"/);
    expect(html).toContain('id="f-domain"');
    expect(html).toContain('id="f-verdict"');
  });

  it("never embeds an absolute or machine-local path, a CDN, or an external script", () => {
    const html = renderHtml(buildDisplayRows(fixture, []));
    expect(html).not.toMatch(/\/Users\/|\/home\/|file:\/\/|^[A-Za-z]:[\\/]/m);
    expect(html).not.toMatch(/https?:\/\/[^"' ]*\.(?:js|css)/);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
    expect(html).not.toMatch(/<link\b/);
    expect(html).toContain('href="../output/edgehunt-D1/SUMMARY.md"');
  });

  it("escapes HTML-significant characters from ledger content", () => {
    const html = renderHtml([
      {
        id: "<x>",
        domain: "D2",
        name: 'a & b "quote"',
        rawVerdict: "KILL",
        auditedVerdict: "KILL",
        flipped: false,
        auditOverrideReason: "",
        lastAudit: "2026-06-01",
        detail: "p<0.05",
        source: "output/edgehunt-D2/SUMMARY.md",
      },
    ]);
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).not.toContain("<x>");
  });

  it("is deterministic for the same input", () => {
    expect(renderHtml(buildDisplayRows(fixture, []))).toBe(renderHtml(buildDisplayRows(fixture, [])));
  });
});

// ---------------------------------------------------------------------------
// Canonical contract: the generator's audited counts == the ledger's, and no
// flipped lead is ever shown as a final PROMISING.
// ---------------------------------------------------------------------------

describe("loadLedger", () => {
  it("loads the committed canonical ledger as the source of truth", () => {
    const entries = loadLedger();
    expect(entries).toEqual(committedLedger);
    expect(entries.length).toBeGreaterThan(50);
  });
});

describe("generator audited counts == ledger audited counts", () => {
  const entries = loadLedger();
  const rows = buildDisplayRows(entries, collectRows());
  const generated = auditedCounts(rows);

  /** The ledger's audited headline, tallied straight from the committed JSON. */
  const ledgerHeadline = committedLedger.reduce(
    (acc, e) => {
      acc[e.auditedVerdict] = (acc[e.auditedVerdict] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  it("matches the ledger headline exactly: 0 SURVIVE, 1 PROMISING", () => {
    expect(generated.SURVIVE).toBe(0);
    expect(generated.PROMISING).toBe(1);
    expect(generated.SURVIVE).toBe(ledgerHeadline.SURVIVE ?? 0);
    expect(generated.PROMISING).toBe(ledgerHeadline.PROMISING);
    expect(generated.KILL).toBe(ledgerHeadline.KILL);
    expect(generated.DEFERRED).toBe(ledgerHeadline.DEFERRED);
  });

  it("the sole audited PROMISING is the dated-futures basis carry", () => {
    const promising = rows
      .filter((r) => r.auditedVerdict === "PROMISING")
      .map((r) => r.id)
      .sort();
    expect(promising).toEqual(["D8-C6-DATED"]);
  });

  it("no row presents a flipped lead as a final PROMISING", () => {
    for (const r of rows) {
      if (r.flipped) {
        // A flipped lead's FINAL/displayed verdict must not be PROMISING.
        expect(r.auditedVerdict).not.toBe("PROMISING");
      }
    }
    // The five documented flips all land on KILL.
    const flips = rows.filter((r) => r.flipped);
    expect(flips.map((r) => r.id).sort()).toEqual([
      "D1-LS-DONCH",
      "D5-08",
      "O3-NVTS",
      "Q9-LOWVOL",
      "VRP-HARVEST",
    ]);
    for (const f of flips) {
      expect(f.rawVerdict).toBe("PROMISING");
      expect(f.auditedVerdict).toBe("KILL");
      expect(f.auditOverrideReason.length).toBeGreaterThan(0);
    }
  });

  it("the rendered HTML's filterable verdict for every flipped lead is its audited verdict", () => {
    const html = renderHtml(rows);
    // Every data-flipped="1" row must carry a non-PROMISING data-verdict.
    const flippedRowRe = /<tr[^>]*data-verdict="([^"]+)"[^>]*data-flipped="1"[^>]*>/g;
    let m: RegExpExecArray | null;
    let flippedSeen = 0;
    while ((m = flippedRowRe.exec(html)) !== null) {
      flippedSeen++;
      expect(m[1]).not.toBe("PROMISING");
    }
    expect(flippedSeen).toBe(5);
  });
});

describe("collectRows (live raw ledgers, provenance)", () => {
  const rows = collectRows();

  it("parses every committed edgehunt SUMMARY.md into raw verdict rows", () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it("finds zero SURVIVE in the raw per-domain ledgers", () => {
    expect(rows.filter((r) => r.verdict === "SURVIVE")).toHaveLength(0);
  });
});
