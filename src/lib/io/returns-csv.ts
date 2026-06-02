/**
 * Pure CSV parsers for returns series and asset panels.
 *
 * These are deliberately string-in / data-out (no file I/O, no Date.now, no RNG)
 * so they stay deterministic and trivially testable. A caller that has read a
 * file from disk passes its text here; the parser only understands the bytes.
 *
 * Two shapes are supported:
 *   - `parseReturnsCsv`: a "long" CSV with a header row and one row per period,
 *     carrying a returns column and (optionally) a position/weight column and a
 *     date/timestamp column. Used for single-strategy validation.
 *   - `parsePanelCsv`: a "wide" CSV with a date column plus one column per asset,
 *     used for cross-sectional / strategy-family work where you need the whole
 *     panel of asset returns aligned on a common date axis.
 *
 * Tolerances: a leading UTF-8 BOM is stripped, surrounding whitespace on header
 * cells and values is trimmed, fully blank lines are skipped, and both `\n` and
 * `\r\n` line endings are accepted. Column matching is case-insensitive and
 * accepts common aliases. Anything that cannot be parsed as a finite number in a
 * numeric column raises a clear, located error rather than silently coercing to
 * NaN.
 */

/** Parsed result of a long returns CSV. */
export interface ParsedReturnsCsv {
  /** One return per data row, in file order. Always present. */
  returns: number[];
  /** One signed position/weight per data row, if a positions column was found. */
  positions?: number[];
  /** One date string per data row, if a date/timestamp column was found. */
  dates?: string[];
}

/** Parsed result of a wide asset-panel CSV. */
export interface ParsedPanelCsv {
  /** One date string per data row, in file order. */
  dates: string[];
  /** Asset (column) names, in file order, excluding the date column. */
  assets: string[];
  /** `panel[row][asset]` aligned to `dates` (rows) and `assets` (columns). */
  panel: number[][];
}

/** Header aliases accepted for the returns column (case-insensitive). */
const RETURN_ALIASES = ["return", "returns", "ret", "pnl"];
/** Header aliases accepted for the position/weight column (case-insensitive). */
const POSITION_ALIASES = ["position", "positions", "pos", "weight", "weights"];
/** Header aliases accepted for the date column (case-insensitive). */
const DATE_ALIASES = ["date", "dates", "timestamp", "time", "datetime"];

/**
 * Parse a long returns CSV string into a returns series plus optional positions
 * and dates. Throws if no returns column can be located, or if any value in the
 * returns/positions columns is non-numeric.
 */
export function parseReturnsCsv(text: string): ParsedReturnsCsv {
  const rows = toRows(text);
  if (rows.length === 0) {
    throw new Error("parseReturnsCsv: CSV is empty (no header row found).");
  }

  const header = rows[0]!.map(normalizeHeaderCell);
  const returnIdx = findColumn(header, RETURN_ALIASES);
  if (returnIdx === -1) {
    throw new Error(
      `parseReturnsCsv: no returns column found. Expected one of [${RETURN_ALIASES.join(
        ", ",
      )}] (case-insensitive) in header [${header.join(", ")}].`,
    );
  }
  const positionIdx = findColumn(header, POSITION_ALIASES);
  const dateIdx = findColumn(header, DATE_ALIASES);

  const returns: number[] = [];
  const positions: number[] = [];
  const dates: string[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const lineNo = r + 1; // 1-based, header is line 1

    returns.push(
      parseNumericCell(cellAt(row, returnIdx), "returns", header[returnIdx]!, lineNo),
    );

    if (positionIdx !== -1) {
      positions.push(
        parseNumericCell(
          cellAt(row, positionIdx),
          "positions",
          header[positionIdx]!,
          lineNo,
        ),
      );
    }

    if (dateIdx !== -1) {
      dates.push(cellAt(row, dateIdx).trim());
    }
  }

  const result: ParsedReturnsCsv = { returns };
  if (positionIdx !== -1) {
    result.positions = positions;
  }
  if (dateIdx !== -1) {
    result.dates = dates;
  }
  return result;
}

/**
 * Parse a wide asset-panel CSV string (date column + one column per asset) into
 * aligned `dates`, `assets`, and a `panel` matrix. Throws if no date column can
 * be located, if there are no asset columns, or if any panel cell is non-numeric.
 */
export function parsePanelCsv(text: string): ParsedPanelCsv {
  const rows = toRows(text);
  if (rows.length === 0) {
    throw new Error("parsePanelCsv: CSV is empty (no header row found).");
  }

  const rawHeader = rows[0]!;
  const header = rawHeader.map(normalizeHeaderCell);
  const dateIdx = findColumn(header, DATE_ALIASES);
  if (dateIdx === -1) {
    throw new Error(
      `parsePanelCsv: no date column found. Expected one of [${DATE_ALIASES.join(
        ", ",
      )}] (case-insensitive) in header [${header.join(", ")}].`,
    );
  }

  const assetIdx: number[] = [];
  const assets: string[] = [];
  for (let c = 0; c < rawHeader.length; c += 1) {
    if (c === dateIdx) continue;
    assetIdx.push(c);
    assets.push(rawHeader[c]!.trim());
  }
  if (assets.length === 0) {
    throw new Error(
      "parsePanelCsv: no asset columns found (header has only a date column).",
    );
  }

  const dates: string[] = [];
  const panel: number[][] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const lineNo = r + 1;
    dates.push(cellAt(row, dateIdx).trim());

    const panelRow: number[] = [];
    for (let a = 0; a < assetIdx.length; a += 1) {
      const c = assetIdx[a]!;
      panelRow.push(parseNumericCell(cellAt(row, c), "panel", assets[a]!, lineNo));
    }
    panel.push(panelRow);
  }

  return { dates, assets, panel };
}

/**
 * Split CSV text into a matrix of trimmed-but-still-raw cell strings: strips a
 * leading BOM, normalizes line endings, and drops fully blank lines. Cells are
 * split on commas (this is a simple split; quoted commas are out of scope for the
 * numeric/date series this module targets).
 */
function toRows(text: string): string[][] {
  const withoutBom = stripBom(text);
  const lines = withoutBom.split(/\r\n|\r|\n/);
  const rows: string[][] = [];
  for (const line of lines) {
    if (line.trim() === "") continue; // skip blank lines
    rows.push(line.split(","));
  }
  return rows;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Lowercase + trim a header cell for alias matching. */
function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase();
}

/** Index of the first header cell whose normalized value matches an alias. */
function findColumn(normalizedHeader: readonly string[], aliases: readonly string[]): number {
  for (let i = 0; i < normalizedHeader.length; i += 1) {
    if (aliases.includes(normalizedHeader[i]!)) return i;
  }
  return -1;
}

/** Safe column read: missing trailing cells read as empty string. */
function cellAt(row: readonly string[], index: number): string {
  return index < row.length ? row[index]! : "";
}

/**
 * Parse a numeric cell or throw a clear, located error. Empty cells are treated
 * as missing (which is an error in a required numeric column) rather than 0, so a
 * truncated row cannot silently masquerade as a zero return.
 */
function parseNumericCell(
  raw: string,
  columnKind: string,
  columnName: string,
  lineNo: number,
): number {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(
      `parse ${columnKind}: empty value in column "${columnName}" at line ${lineNo}.`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(
      `parse ${columnKind}: non-numeric value "${raw}" in column "${columnName}" at line ${lineNo}.`,
    );
  }
  return value;
}
