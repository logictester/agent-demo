import express from "express";
import crypto from "crypto";
import { getUserInfo } from "../services/onewelcome.js";
import {
  approveOperationById,
  completeIdvSession,
  createOperationApproval,
  createIdvSession,
  getDelegation,
  getOperationApprovalById,
  getIdvSession,
  getDelegationOptions,
  getDelegationPurposeOptions,
  listAuthorizationEvents,
  listPendingApprovals,
  markIdvFailed,
  markIdvVerified,
  setDelegatedOperations,
  verifyApprovedOperation
} from "../services/delegation.js";
import { sendSlackTestNotification } from "../services/slack.js";

const router = express.Router();
const monokeeIdvStartUrl = process.env.MONOKEE_IDV_START_URL || "";
const monokeeStateSecret = process.env.MONOKEE_IDV_STATE_SECRET || "change-this-idv-state-secret";
const monokeeStateTtlSeconds = Number(process.env.MONOKEE_IDV_STATE_TTL_SECONDS) || 900;
const monokeeCallbackSecret = process.env.MONOKEE_IDV_CALLBACK_SECRET || "";
const frontendAppUrl = String(process.env.FRONTEND_APP_URL || "").trim();

function extractBearerToken(headerValue) {
  if (typeof headerValue !== "string") {
    return "";
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function resolveUser(req) {
  const accessToken = extractBearerToken(req.headers.authorization);
  if (!accessToken) {
    return { user: null, accessToken: "" };
  }

  try {
    const user = await getUserInfo(accessToken);
    return { user, accessToken };
  } catch {
    return { user: null, accessToken };
  }
}

function signState(payload) {
  const now = Math.floor(Date.now() / 1000);
  const enriched = {
    ...payload,
    iat: now,
    exp: now + monokeeStateTtlSeconds
  };
  const encoded = Buffer.from(JSON.stringify(enriched)).toString("base64url");
  const signature = crypto.createHmac("sha256", monokeeStateSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyState(stateToken) {
  if (!stateToken || typeof stateToken !== "string") {
    return null;
  }

  const parts = stateToken.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encoded, signature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", monokeeStateSecret)
    .update(encoded)
    .digest("base64url");
  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!payload?.exp || now >= Number(payload.exp)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function normalizeStatus(rawStatus) {
  const value = String(rawStatus || "").toLowerCase();
  if (["verified", "success", "succeeded", "completed", "complete", "ok"].includes(value)) {
    return "verified";
  }
  return "failed";
}

function buildReturnUrl(returnTo, status) {
  const base = typeof returnTo === "string" && returnTo.startsWith("/") ? returnTo : "/";
  const url = new URL(base, frontendAppUrl || "http://local");
  url.searchParams.set("idv_status", status);
  if (!frontendAppUrl) {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

router.get("/options", (req, res) => {
  return res.json({
    options: getDelegationOptions(),
    purposeOptions: getDelegationPurposeOptions()
  });
});

router.get("/status", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const delegation = await getDelegation(user.sub);
  return res.json({
    idvVerified: delegation.idvVerified,
    idvVerifiedAt: delegation.idvVerifiedAt,
    delegatedOperations: delegation.delegatedOperations,
    constraints: delegation.constraints || {}
  });
});

router.post("/idv/start", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required for IDV verification" });
  }

  if (!monokeeIdvStartUrl) {
    return res
      .status(500)
      .json({ error: "MONOKEE_IDV_START_URL is not configured on the backend." });
  }

  const body = req.body ?? {};
  const returnTo =
    typeof body.returnTo === "string" && body.returnTo.startsWith("/") ? body.returnTo : "/";

  const session = await createIdvSession(user.sub, { returnTo });
  const state = signState({
    sid: session.id,
    sub: user.sub,
    returnTo
  });

  const redirectUrl = new URL(monokeeIdvStartUrl);
  redirectUrl.searchParams.set("state", state);
  redirectUrl.searchParams.set("sub", user.sub);

  return res.json({ redirectUrl: redirectUrl.toString() });
});

router.post("/idv/callback", async (req, res) => {
  if (monokeeCallbackSecret) {
    const providedSecret = String(req.headers["x-monokee-callback-secret"] || "");
    if (!providedSecret || providedSecret !== monokeeCallbackSecret) {
      return res.status(401).json({ error: "Invalid callback secret" });
    }
  }

  const body = req.body ?? {};
  const state = body.state || req.query.state;
  const status = normalizeStatus(body.status || body.idv_status || body.result || body.outcome);
  const scenarioId = body.scenarioId || body.scenario_id || body.id || null;

  const payload = verifyState(state);
  if (!payload?.sid || !payload?.sub) {
    return res.status(400).json({ error: "Invalid or expired IDV callback state." });
  }

  const session = await getIdvSession(payload.sid);
  if (!session || session.sub !== payload.sub) {
    return res.status(400).json({ error: "Unknown IDV session." });
  }

  await completeIdvSession(payload.sid, status, scenarioId);
  if (status === "verified") {
    await markIdvVerified(payload.sub);
  } else {
    await markIdvFailed(payload.sub);
  }

  return res.json({
    message: "IDV callback processed.",
    status
  });
});

router.get("/idv/callback", async (req, res) => {
  if (monokeeCallbackSecret) {
    const providedSecret = String(req.headers["x-monokee-callback-secret"] || "");
    if (!providedSecret || providedSecret !== monokeeCallbackSecret) {
      return res.status(401).send("Invalid callback secret");
    }
  }

  const state = req.query.state;
  const status = normalizeStatus(req.query.status || req.query.idv_status || req.query.result);
  const scenarioId = req.query.scenarioId || req.query.scenario_id || null;

  const payload = verifyState(state);
  if (!payload?.sid || !payload?.sub) {
    return res.status(400).send("Invalid or expired IDV callback state.");
  }

  const session = await getIdvSession(payload.sid);
  if (!session || session.sub !== payload.sub) {
    return res.status(400).send("Unknown IDV session.");
  }

  await completeIdvSession(payload.sid, status, scenarioId);
  if (status === "verified") {
    await markIdvVerified(payload.sub);
  } else {
    await markIdvFailed(payload.sub);
  }

  return res.redirect(buildReturnUrl(payload.returnTo, status));
});

router.post("/grants", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { operations, constraints } = req.body ?? {};
  try {
    const delegation = await setDelegatedOperations(user.sub, operations, constraints || {});
    return res.json({
      message: "Delegation updated.",
      idvVerified: delegation.idvVerified,
      idvVerifiedAt: delegation.idvVerifiedAt,
      delegatedOperations: delegation.delegatedOperations,
      constraints: delegation.constraints || {}
    });
  } catch (error) {
    if (error?.message === "IDV_REQUIRED") {
      return res.status(400).json({ error: "Complete IDV verification before delegating actions." });
    }
    return res.status(500).json({ error: "Failed to update delegation." });
  }
});

router.post("/approvals", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const body = req.body ?? {};
  const created = await createOperationApproval(user.sub, {
    approvalType: body.approvalType || "high_risk_transfer",
    reason: body.reason || null,
    payload: body.payload || {},
    ttlSeconds: body.ttlSeconds || null
  });
  if (!created) {
    return res.status(500).json({ error: "Failed to create approval request" });
  }
  return res.status(201).json({ approval: created });
});

router.get("/approvals/:id", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const approval = await getOperationApprovalById(req.params.id);
  if (!approval || approval.sub !== user.sub) {
    return res.status(404).json({ error: "Approval not found" });
  }
  return res.json({ approval });
});

router.get("/approvals", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const approvals = await listPendingApprovals(user.sub, 30);
  return res.json({ approvals });
});

router.get("/events", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const limit = Number(req.query.limit) || 40;
  const events = await listAuthorizationEvents(user.sub, limit);
  return res.json({ events });
});

router.post("/notifications/slack/test", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const result = await sendSlackTestNotification(user);
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || "Slack test notification could not be sent." });
    }
    return res.json({ ok: true, message: "Slack test notification sent." });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Slack test notification failed." });
  }
});

router.post("/approvals/:id/approve", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const approval = await approveOperationById(user.sub, req.params.id);
  if (!approval) {
    return res.status(404).json({ error: "Approval not found" });
  }
  return res.json({ approval });
});

router.post("/approvals/:id/verify", async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const expectedType = String(req.body?.expectedType || "").trim() || null;
  const verification = await verifyApprovedOperation(user.sub, req.params.id, expectedType);
  return res.json(verification);
});

export default router;
