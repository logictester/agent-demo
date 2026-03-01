import express from "express";
import { runAgent } from "../agent/agent.js";
import { decodeJwtClaims, getUserInfo } from "../services/onewelcome.js";
import {
  getDelegation,
  getUserFinancialState,
  recordAgentInteraction
} from "../services/delegation.js";
import { verifyStepUpTicket } from "../services/stepup.js";

const router = express.Router();

function extractBearerToken(headerValue) {
  if (typeof headerValue !== "string") {
    return "";
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function extractIdToken(headerValue) {
  return typeof headerValue === "string" ? headerValue : "";
}

function extractClientTimeZone(headerValue) {
  const value = typeof headerValue === "string" ? headerValue.trim() : "";
  if (!value || value.length > 80) {
    return "";
  }
  return value;
}

router.post("/", async (req, res) => {
  const { message } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message must be a non-empty string" });
  }

  try {
    const trimmedMessage = message.trim();
    let stepUpVerified = false;
    const accessToken = extractBearerToken(req.headers.authorization);
    const idToken = extractIdToken(req.headers["x-id-token"]);
    const clientTimeZone = extractClientTimeZone(req.headers["x-client-timezone"]);
    const clientLocale = typeof req.headers["x-client-locale"] === "string" ? req.headers["x-client-locale"] : "";
    let userInfo = null;
    const idTokenClaims = decodeJwtClaims(idToken) || null;

    if (accessToken) {
      try {
        userInfo = await getUserInfo(accessToken);
      } catch {
        userInfo = null;
      }
    }

    const stepUpTicket = req.headers["x-step-up-ticket"];
    if (accessToken && userInfo && typeof stepUpTicket === "string") {
      const verification = verifyStepUpTicket(stepUpTicket, userInfo?.sub);
      stepUpVerified = verification.valid;
    }

    const mergedIdentity =
      userInfo && idTokenClaims
        ? { ...userInfo, ...idTokenClaims }
        : userInfo || idTokenClaims || null;
    const conversationKey = mergedIdentity?.sub || userInfo?.sub || idTokenClaims?.sub || null;
    const delegation = userInfo?.sub
      ? await getDelegation(userInfo.sub)
      : { idvVerified: false, idvVerifiedAt: null, delegatedOperations: [] };

    const result = await runAgent(trimmedMessage, {
      stepUpVerified,
      userInfo: mergedIdentity,
      tokenVerified: Boolean(userInfo),
      delegation,
      userSub: userInfo?.sub || null,
      conversationKey,
      clientTimeZone,
      clientLocale
    });
    const financialState = userInfo?.sub ? await getUserFinancialState(userInfo.sub) : null;
    if (typeof result === "string") {
      return res.json({ output: result });
    }

    if (userInfo?.sub) {
      await recordAgentInteraction(userInfo.sub, {
        question: trimmedMessage,
        intent: result.intent || null,
        operationKey: result.operationKey || null,
        answered: Boolean(result.output),
        operationPerformed: Boolean(result.operationPerformed)
      });
    }
    const updatedFinancialState = userInfo?.sub ? await getUserFinancialState(userInfo.sub) : null;

    return res.json({
      intent: result.intent || null,
      operationKey: result.operationKey || null,
      output: result.output || "",
      transfer: result.transfer || null,
      riskStatus: result.riskStatus || "Normal",
      requiresReauth: Boolean(result.requiresReauth),
      reauthUrl: result.reauthUrl || null,
      balances: result.balances || updatedFinancialState?.balances || financialState?.balances || null,
      transactionHistory:
        result.transactionHistory || updatedFinancialState?.transactionHistory || financialState?.transactionHistory || [],
      interactionStats: updatedFinancialState?.interactionStats || financialState?.interactionStats || null,
      decisionFlow: Array.isArray(result.decisionFlow) ? result.decisionFlow : [],
      source: result.source || "deterministic",
      model: result.model || null,
      baseUrl: result.baseUrl || null
    });
  } catch (error) {
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const ollamaModel = process.env.OLLAMA_MODEL || "llama3.1:8b";
    const message =
      error?.message === "fetch failed"
        ? `Agent execution failed: cannot reach Ollama at ${ollamaBaseUrl}. Ensure that host is reachable and model ${ollamaModel} is available.`
        : error?.message || "Agent execution failed.";
    return res.status(500).json({ error: message });
  }
});

router.get("/state", async (req, res) => {
  try {
    const accessToken = extractBearerToken(req.headers.authorization);
    if (!accessToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const userInfo = await getUserInfo(accessToken);
    if (!userInfo?.sub) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const financialState = await getUserFinancialState(userInfo.sub, 50);
    return res.json({
      balances: financialState.balances,
      transactionHistory: financialState.transactionHistory,
      interactionStats: financialState.interactionStats
    });
  } catch {
    return res.status(500).json({ error: "Failed to load account state" });
  }
});

export default router;
