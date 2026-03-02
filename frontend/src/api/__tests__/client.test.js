import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as api from "../client";

describe("API client", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
    });
  }

  describe("auth headers", () => {
    it("includes Bearer token when access_token is in localStorage", async () => {
      localStorage.setItem("access_token", "test-token-123");
      mockFetch.mockReturnValue(jsonResponse({ ok: true }));

      await api.getSessionConfig();

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers.Authorization).toBe("Bearer test-token-123");
    });

    it("does not include Authorization when no token", async () => {
      mockFetch.mockReturnValue(jsonResponse({ ok: true }));

      await api.getSessionConfig();

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers.Authorization).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("throws when response is not ok", async () => {
      mockFetch.mockReturnValue(
        jsonResponse({ error: "Unauthorized" }, false, 401)
      );

      await expect(api.getSessionConfig()).rejects.toThrow("Unauthorized");
    });

    it("throws generic message when no error field", async () => {
      mockFetch.mockReturnValue(jsonResponse({}, false, 500));

      await expect(api.getSessionConfig()).rejects.toThrow("Request failed");
    });
  });

  describe("auth endpoints", () => {
    it("getSessionConfig calls GET /auth/session-config", async () => {
      mockFetch.mockReturnValue(jsonResponse({ sessionWarningSeconds: 120 }));

      const data = await api.getSessionConfig();

      expect(mockFetch).toHaveBeenCalledWith("/auth/session-config", expect.any(Object));
      expect(data.sessionWarningSeconds).toBe(120);
    });

    it("refreshTokens calls POST /auth/refresh", async () => {
      mockFetch.mockReturnValue(jsonResponse({ access_token: "new-token" }));

      await api.refreshTokens("old-refresh");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/auth/refresh");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ refreshToken: "old-refresh" });
    });
  });

  describe("agent endpoints", () => {
    it("sendAgentMessage calls POST /agent with message", async () => {
      mockFetch.mockReturnValue(
        jsonResponse({ output: "Hello", intent: "general_question" })
      );

      const data = await api.sendAgentMessage("hello there", {
        "X-Client-Timezone": "UTC",
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/agent");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ message: "hello there" });
      expect(opts.headers["X-Client-Timezone"]).toBe("UTC");
      expect(data.output).toBe("Hello");
    });

    it("getAgentState calls GET /agent/state", async () => {
      mockFetch.mockReturnValue(
        jsonResponse({ balances: { availableBalance: 100 } })
      );

      const data = await api.getAgentState();

      expect(mockFetch).toHaveBeenCalledWith("/agent/state", expect.any(Object));
      expect(data.balances.availableBalance).toBe(100);
    });
  });

  describe("delegation endpoints", () => {
    it("getDelegationOptions calls GET /delegation/options", async () => {
      mockFetch.mockReturnValue(jsonResponse({ options: [] }));
      await api.getDelegationOptions();
      expect(mockFetch.mock.calls[0][0]).toBe("/delegation/options");
    });

    it("getDelegationStatus calls GET /delegation/status", async () => {
      mockFetch.mockReturnValue(jsonResponse({ idvVerified: true }));
      await api.getDelegationStatus();
      expect(mockFetch.mock.calls[0][0]).toBe("/delegation/status");
    });

    it("startIdv calls POST /delegation/idv/start", async () => {
      mockFetch.mockReturnValue(jsonResponse({ redirectUrl: "https://example.com" }));
      await api.startIdv("/callback");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/delegation/idv/start");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ returnTo: "/callback" });
    });

    it("saveDelegationGrants calls POST /delegation/grants", async () => {
      mockFetch.mockReturnValue(jsonResponse({ delegatedOperations: ["transfer_funds"] }));
      await api.saveDelegationGrants(["transfer_funds"], { purpose: "general" });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/delegation/grants");
      expect(opts.method).toBe("POST");
    });

    it("approveOperation calls POST with correct URL", async () => {
      mockFetch.mockReturnValue(jsonResponse({ status: "approved" }));
      await api.approveOperation("approval-123");
      expect(mockFetch.mock.calls[0][0]).toBe("/delegation/approvals/approval-123/approve");
    });

    it("getAuthorizationEvents calls with limit param", async () => {
      mockFetch.mockReturnValue(jsonResponse({ events: [] }));
      await api.getAuthorizationEvents(30);
      expect(mockFetch.mock.calls[0][0]).toBe("/delegation/events?limit=30");
    });
  });

  describe("automation endpoints", () => {
    it("getAutomationRules calls GET /automation/rules", async () => {
      mockFetch.mockReturnValue(jsonResponse({ rules: [] }));
      await api.getAutomationRules();
      expect(mockFetch.mock.calls[0][0]).toBe("/automation/rules");
    });

    it("createAutomationRule calls POST /automation/rules", async () => {
      mockFetch.mockReturnValue(jsonResponse({ rule: {} }));
      await api.createAutomationRule({ name: "Test" });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/automation/rules");
      expect(opts.method).toBe("POST");
    });

    it("updateAutomationRule calls PUT with id", async () => {
      mockFetch.mockReturnValue(jsonResponse({ rule: {} }));
      await api.updateAutomationRule("rule-1", { enabled: false });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/automation/rules/rule-1");
      expect(opts.method).toBe("PUT");
    });

    it("deleteAutomationRule calls DELETE with id", async () => {
      mockFetch.mockReturnValue(jsonResponse({ deleted: true }));
      await api.deleteAutomationRule("rule-1");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/automation/rules/rule-1");
      expect(opts.method).toBe("DELETE");
    });

    it("runAutomationRule calls POST with id/run", async () => {
      mockFetch.mockReturnValue(jsonResponse({ result: { status: "completed" } }));
      await api.runAutomationRule("rule-1");
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/automation/rules/rule-1/run");
      expect(opts.method).toBe("POST");
    });
  });
});
