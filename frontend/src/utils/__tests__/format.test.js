import { describe, it, expect } from "vitest";
import { formatCurrency, formatShortTimestamp, formatRunTimestamp } from "../format";

describe("formatCurrency", () => {
  it("formats a positive number as USD", () => {
    expect(formatCurrency(1234.56)).toBe("$1,234.56");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats a negative number", () => {
    expect(formatCurrency(-50)).toBe("-$50.00");
  });

  it("formats a large number with commas", () => {
    expect(formatCurrency(24982.14)).toBe("$24,982.14");
  });

  it("handles whole numbers", () => {
    expect(formatCurrency(100)).toBe("$100.00");
  });
});

describe("formatShortTimestamp", () => {
  it("returns empty string for empty input", () => {
    expect(formatShortTimestamp("")).toBe("");
  });

  it("returns empty string for null", () => {
    expect(formatShortTimestamp(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatShortTimestamp(undefined)).toBe("");
  });

  it("formats a valid ISO string", () => {
    const result = formatShortTimestamp("2024-06-15T10:30:00Z");
    // Should contain some date-like content (locale-dependent)
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(5);
  });
});

describe("formatRunTimestamp", () => {
  it('returns "Not scheduled" for null', () => {
    expect(formatRunTimestamp(null)).toBe("Not scheduled");
  });

  it('returns "Not scheduled" for empty string', () => {
    expect(formatRunTimestamp("")).toBe("Not scheduled");
  });

  it('returns "Not scheduled" for undefined', () => {
    expect(formatRunTimestamp(undefined)).toBe("Not scheduled");
  });

  it("formats a valid ISO string", () => {
    const result = formatRunTimestamp("2024-06-15T10:30:00Z");
    expect(result).toBeTruthy();
    expect(result).not.toBe("Not scheduled");
  });
});
