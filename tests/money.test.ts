import { describe, expect, it } from "vitest";
import { parseMoney } from "../src/shared/money.ts";

// QA-22: a comma used as the decimal mark must never be read as a thousands separator.
describe("typed amounts", () => {
  it.each([
    ["95", 9500],
    ["95.5", 9550],
    ["95.50", 9550],
    ["1,50", 150],
    ["12,5", 1250],
    ["0,99", 99],
    [",5", 50],
    [".5", 50],
    ["5.", 500],
    ["1,500", 150000],
    ["1,250.50", 125050],
    ["1.250,50", 125050],
    ["1.234.567", 123456700],
    ["1,234,567.89", 123456789],
    ["1 250,50", 125050],
    ["1'250.50", 125050],
    ["$42.50", 4250],
    ["42,50 €", 4250],
    ["EUR 42,50", 4250],
    ["999999999.99", 99999999999],
  ])("%s is %i cents", (text, cents) => {
    expect(parseMoney(text)).toBe(cents);
  });

  it.each(["", "   "])("%j is empty", (text) => {
    expect(parseMoney(text)).toBeNull();
  });

  it.each(["1.500", "1,2345", "1,234,56", "1,234.567", "1.2.3", "12.345", ".", ",", "-5", "1e3", "abc", "€", "1234567890", "1,23,456"])(
    "%j can't be read for certain",
    (text) => {
      expect(parseMoney(text)).toBeNaN();
    },
  );
});
