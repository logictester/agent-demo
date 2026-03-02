import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  decodeJwtClaims,
  getValidStepUpTicket,
  getSessionSecondsRemaining,
  resolveDisplayName,
  readQuestionHistory,
  getOperationSource,
  getAutomationExecutionType,
} from "../AppContext";

// Helper to create a minimal JWT with given payload
function makeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

describe("decodeJwtClaims", () => {
  it("decodes a valid JWT payload", () => {
    const token = makeJwt({ sub: "user-1", email: "a@b.com" });
    const claims = decodeJwtClaims(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("a@b.com");
  });

  it("returns null for null input", () => {
    expect(decodeJwtClaims(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeJwtClaims("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(decodeJwtClaims(123)).toBeNull();
  });

  it("returns null for malformed token (single part)", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
  });

  it("returns null for invalid base64 payload", () => {
    expect(decodeJwtClaims("header.!!!invalid!!!.sig")).toBeNull();
  });
});

describe("getValidStepUpTicket", () => {
  beforeEach(() => localStorage.clear());

  it("returns empty string when no ticket stored", () => {
    expect(getValidStepUpTicket()).toBe("");
  });

  it("returns ticket when not expired", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 600;
    localStorage.setItem("helio.stepUpTicket", "ticket-abc");
    localStorage.setItem("helio.stepUpTicketExp", String(futureExp));

    expect(getValidStepUpTicket()).toBe("ticket-abc");
  });

  it("returns empty string and clears when expired", () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    localStorage.setItem("helio.stepUpTicket", "ticket-old");
    localStorage.setItem("helio.stepUpTicketExp", String(pastExp));

    expect(getValidStepUpTicket()).toBe("");
    expect(localStorage.getItem("helio.stepUpTicket")).toBeNull();
    expect(localStorage.getItem("helio.stepUpTicketExp")).toBeNull();
  });

  it("returns empty string when exp is not a number", () => {
    localStorage.setItem("helio.stepUpTicket", "ticket-x");
    localStorage.setItem("helio.stepUpTicketExp", "not-a-number");

    expect(getValidStepUpTicket()).toBe("");
  });
});

describe("getSessionSecondsRemaining", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when no id_token", () => {
    expect(getSessionSecondsRemaining()).toBeNull();
  });

  it("returns positive seconds for future expiry", () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    localStorage.setItem("id_token", makeJwt({ exp }));

    const remaining = getSessionSecondsRemaining();
    expect(remaining).toBeGreaterThan(290);
    expect(remaining).toBeLessThanOrEqual(300);
  });

  it("returns negative seconds for past expiry", () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    localStorage.setItem("id_token", makeJwt({ exp }));

    expect(getSessionSecondsRemaining()).toBeLessThan(0);
  });

  it("returns null for token without exp claim", () => {
    localStorage.setItem("id_token", makeJwt({ sub: "user" }));
    expect(getSessionSecondsRemaining()).toBeNull();
  });
});

describe("resolveDisplayName", () => {
  beforeEach(() => localStorage.clear());

  it('returns "Guest User" when no id_token', () => {
    expect(resolveDisplayName()).toBe("Guest User");
  });

  it("returns formatted fullName when present", () => {
    localStorage.setItem(
      "id_token",
      makeJwt({ fullName: { formatted: "John Doe" } })
    );
    expect(resolveDisplayName()).toBe("John Doe");
  });

  it("composes given + family name", () => {
    localStorage.setItem(
      "id_token",
      makeJwt({ given_name: "Jane", family_name: "Smith" })
    );
    expect(resolveDisplayName()).toBe("Jane Smith");
  });

  it("falls back to email", () => {
    localStorage.setItem("id_token", makeJwt({ email: "user@example.com" }));
    expect(resolveDisplayName()).toBe("user@example.com");
  });

  it("falls back to sub", () => {
    localStorage.setItem("id_token", makeJwt({ sub: "user-id-123" }));
    expect(resolveDisplayName()).toBe("user-id-123");
  });

  it('returns "Guest User" for token with empty claims', () => {
    localStorage.setItem("id_token", makeJwt({}));
    expect(resolveDisplayName()).toBe("Guest User");
  });
});

describe("readQuestionHistory", () => {
  beforeEach(() => localStorage.clear());

  it("returns empty array when nothing stored", () => {
    expect(readQuestionHistory()).toEqual([]);
  });

  it("parses a valid JSON array", () => {
    localStorage.setItem(
      "helio.questionHistory",
      JSON.stringify(["q1", "q2", "q3"])
    );
    expect(readQuestionHistory()).toEqual(["q1", "q2", "q3"]);
  });

  it("filters out empty strings", () => {
    localStorage.setItem(
      "helio.questionHistory",
      JSON.stringify(["q1", "", null, "q2"])
    );
    expect(readQuestionHistory()).toEqual(["q1", "q2"]);
  });

  it("limits to 10 items", () => {
    const items = Array.from({ length: 15 }, (_, i) => `q${i}`);
    localStorage.setItem("helio.questionHistory", JSON.stringify(items));
    expect(readQuestionHistory()).toHaveLength(10);
  });

  it("returns empty array for invalid JSON", () => {
    localStorage.setItem("helio.questionHistory", "not-json");
    expect(readQuestionHistory()).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    localStorage.setItem("helio.questionHistory", JSON.stringify({ foo: 1 }));
    expect(readQuestionHistory()).toEqual([]);
  });
});

describe("getOperationSource", () => {
  it('returns "prompt" for tx without metadata', () => {
    expect(getOperationSource({})).toBe("prompt");
  });

  it('returns "automation" when operationSource is automation', () => {
    expect(
      getOperationSource({ metadata: { operationSource: "automation" } })
    ).toBe("automation");
  });

  it('returns "prompt" when operationSource is prompt', () => {
    expect(
      getOperationSource({ metadata: { operationSource: "prompt" } })
    ).toBe("prompt");
  });

  it('returns "automation" when automationRuleId is present', () => {
    expect(
      getOperationSource({ metadata: { automationRuleId: "rule-1" } })
    ).toBe("automation");
  });

  it('returns "automation" when automated flag is set', () => {
    expect(getOperationSource({ metadata: { automated: true } })).toBe(
      "automation"
    );
  });
});

describe("getAutomationExecutionType", () => {
  it("returns null for tx without metadata", () => {
    expect(getAutomationExecutionType({})).toBeNull();
  });

  it('returns "scheduled" when automationExecutionType is scheduled', () => {
    expect(
      getAutomationExecutionType({
        metadata: { automationExecutionType: "scheduled" },
      })
    ).toBe("scheduled");
  });

  it('returns "on_demand" when automationExecutionType is on_demand', () => {
    expect(
      getAutomationExecutionType({
        metadata: { automationExecutionType: "on_demand" },
      })
    ).toBe("on_demand");
  });

  it('returns "scheduled" when automated + scheduled flags', () => {
    expect(
      getAutomationExecutionType({
        metadata: { automated: true, scheduled: true },
      })
    ).toBe("scheduled");
  });

  it('returns "on_demand" when automated but not scheduled', () => {
    expect(
      getAutomationExecutionType({ metadata: { automated: true } })
    ).toBe("on_demand");
  });
});
