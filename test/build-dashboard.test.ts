import { describe, expect, it } from "vitest";

import {
  collectRows,
  domainFromDir,
  extractTables,
  isVerdictTable,
  normalizeVerdict,
  parseLedger,
  renderHtml,
  splitRow,
  type Row,
} from "../scripts/build-dashboard";

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

describe("renderHtml", () => {
  const rows: Row[] = [
    {
      domain: "D1",
      id: "D1-03",
      name: "Supertrend overlay",
      verdict: "KILL",
      verdictRaw: "KILL",
      source: "output/edgehunt-D1/SUMMARY.md",
      detail: "deflated-sharpe",
    },
    {
      domain: "requeue",
      id: "D1-LS-DONCH",
      name: "XS Donchian L/S",
      verdict: "PROMISING",
      verdictRaw: "PROMISING",
      source: "output/edgehunt-requeue/SUMMARY.md",
      detail: "honest-N",
    },
  ];

  it("emits a self-contained document with a table and the headline framing", () => {
    const html = renderHtml(rows);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<table");
    expect(html).toContain("0 SURVIVE");
    expect(html).toContain("2 weak PROMISING");
    expect(html).toContain("~111 trading hypotheses");
  });

  it("never embeds an absolute or machine-local path, a CDN, or an external script", () => {
    const html = renderHtml(rows);
    expect(html).not.toMatch(/\/Users\/|\/home\/|codex-runtimes|file:\/\//);
    expect(html).not.toMatch(/https?:\/\/[^"' ]*\.(?:js|css)/);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
    expect(html).not.toMatch(/<link\b/);
    // Ledger links must be repo-relative (../output/...).
    expect(html).toContain('href="../output/edgehunt-D1/SUMMARY.md"');
  });

  it("escapes HTML-significant characters from ledger content", () => {
    const html = renderHtml([
      {
        domain: "D2",
        id: "<x>",
        name: 'a & b "quote"',
        verdict: "KILL",
        verdictRaw: "KILL",
        source: "output/edgehunt-D2/SUMMARY.md",
        detail: "p<0.05",
      },
    ]);
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).not.toContain("<x>");
  });

  it("is deterministic for the same input", () => {
    expect(renderHtml(rows)).toBe(renderHtml(rows));
  });
});

describe("collectRows (live ledgers)", () => {
  const rows = collectRows();

  it("parses every committed edgehunt SUMMARY.md into verdict rows", () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it("finds zero SURVIVE across all per-domain ledgers", () => {
    expect(rows.filter((r) => r.verdict === "SURVIVE")).toHaveLength(0);
  });

  it("excludes the audit trust-roll-up tables (no spurious rows from edgehunt-audit)", () => {
    expect(rows.filter((r) => r.domain === "audit")).toHaveLength(0);
  });

  it("renders the live ledgers to valid, leak-free, self-contained HTML", () => {
    const html = renderHtml(rows);
    expect(html).toContain("<table");
    expect(html).not.toMatch(/\/Users\/|codex-runtimes|file:\/\//);
    const trOpen = (html.match(/<tr[ >]/g) ?? []).length;
    const trClose = (html.match(/<\/tr>/g) ?? []).length;
    expect(trOpen).toBe(trClose);
  });
});
