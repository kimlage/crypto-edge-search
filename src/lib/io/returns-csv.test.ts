import { describe, expect, it } from "vitest";
import { parsePanelCsv, parseReturnsCsv } from "./returns-csv";

describe("parseReturnsCsv", () => {
  it("parses a simple returns CSV", () => {
    const csv = ["return", "0.01", "-0.02", "0.005"].join("\n");
    const result = parseReturnsCsv(csv);

    expect(result.returns).toEqual([0.01, -0.02, 0.005]);
    expect(result.positions).toBeUndefined();
    expect(result.dates).toBeUndefined();
  });

  it("accepts alternate returns column names and is case-insensitive", () => {
    expect(parseReturnsCsv("PnL\n0.1\n0.2").returns).toEqual([0.1, 0.2]);
    expect(parseReturnsCsv("Ret\n0.3").returns).toEqual([0.3]);
    expect(parseReturnsCsv("Returns\n-0.4").returns).toEqual([-0.4]);
  });

  it("parses a positions column under any accepted alias", () => {
    const csv = ["ret,weight", "0.01,1", "0.02,-0.5", "0.03,2"].join("\n");
    const result = parseReturnsCsv(csv);

    expect(result.returns).toEqual([0.01, 0.02, 0.03]);
    expect(result.positions).toEqual([1, -0.5, 2]);
  });

  it("parses a date column and tolerates whitespace, BOM and blank lines", () => {
    const csv = ["﻿Date , Return , Position", "2024-01-01 , 0.01 , 1", "", "2024-01-02 ,-0.02, -1", ""].join(
      "\n",
    );
    const result = parseReturnsCsv(csv);

    expect(result.dates).toEqual(["2024-01-01", "2024-01-02"]);
    expect(result.returns).toEqual([0.01, -0.02]);
    expect(result.positions).toEqual([1, -1]);
  });

  it("accepts \\r\\n line endings", () => {
    const csv = "return\r\n0.01\r\n0.02\r\n";
    expect(parseReturnsCsv(csv).returns).toEqual([0.01, 0.02]);
  });

  it("throws a clear error when no returns column is present", () => {
    const csv = ["date,position", "2024-01-01,1"].join("\n");
    expect(() => parseReturnsCsv(csv)).toThrow(/no returns column found/);
  });

  it("throws a clear error on a non-numeric returns value", () => {
    const csv = ["return", "0.01", "oops"].join("\n");
    expect(() => parseReturnsCsv(csv)).toThrow(/non-numeric value "oops".*line 3/);
  });

  it("throws on a non-numeric positions value", () => {
    const csv = ["return,pos", "0.01,abc"].join("\n");
    expect(() => parseReturnsCsv(csv)).toThrow(/non-numeric value "abc"/);
  });

  it("throws on an empty cell in a required numeric column", () => {
    const csv = ["return", "0.01", ""].join("\n");
    // The blank line is skipped, so reaching a truly missing value requires a
    // trailing comma row that keeps the line non-blank.
    const csv2 = ["return,pos", "0.01,1", ",2"].join("\n");
    expect(() => parseReturnsCsv(csv2)).toThrow(/empty value.*line 3/);
    // And a single blank trailing line is simply ignored:
    expect(parseReturnsCsv(csv).returns).toEqual([0.01]);
  });
});

describe("parsePanelCsv", () => {
  it("parses a wide panel CSV into aligned dates, assets and matrix", () => {
    const csv = [
      "date,BTC,ETH,SOL",
      "2024-01-01,0.01,0.02,-0.03",
      "2024-01-02,-0.01,0.00,0.04",
    ].join("\n");
    const result = parsePanelCsv(csv);

    expect(result.dates).toEqual(["2024-01-01", "2024-01-02"]);
    expect(result.assets).toEqual(["BTC", "ETH", "SOL"]);
    expect(result.panel).toEqual([
      [0.01, 0.02, -0.03],
      [-0.01, 0.0, 0.04],
    ]);
  });

  it("tolerates BOM, whitespace, blank lines and a timestamp alias", () => {
    const csv = ["﻿ Timestamp , BTC , ETH ", " 1 , 0.1 , 0.2 ", "", " 2 ,-0.1,-0.2"].join("\n");
    const result = parsePanelCsv(csv);

    expect(result.dates).toEqual(["1", "2"]);
    expect(result.assets).toEqual(["BTC", "ETH"]);
    expect(result.panel).toEqual([
      [0.1, 0.2],
      [-0.1, -0.2],
    ]);
  });

  it("throws when no date column is present", () => {
    const csv = ["BTC,ETH", "0.1,0.2"].join("\n");
    expect(() => parsePanelCsv(csv)).toThrow(/no date column found/);
  });

  it("throws when there are no asset columns", () => {
    const csv = ["date", "2024-01-01"].join("\n");
    expect(() => parsePanelCsv(csv)).toThrow(/no asset columns found/);
  });

  it("throws a clear error on a non-numeric panel cell", () => {
    const csv = ["date,BTC,ETH", "2024-01-01,0.1,nope"].join("\n");
    expect(() => parsePanelCsv(csv)).toThrow(/non-numeric value "nope".*column "ETH".*line 2/);
  });
});
