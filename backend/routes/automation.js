import express from "express";
import { getUserInfo } from "../services/onewelcome.js";
import {
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
  updateAutomationRule,
  runAutomationRuleNow
} from "../services/automation.js";

const router = express.Router();

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
    return null;
  }

  try {
    const user = await getUserInfo(accessToken);
    return user?.sub ? user : null;
  } catch {
    return null;
  }
}

router.get("/rules", async (req, res) => {
  const user = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const rules = await listAutomationRules(user.sub);
  return res.json({ rules });
});

router.post("/rules", async (req, res) => {
  const user = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const rule = await createAutomationRule(user.sub, req.body || {});
    return res.status(201).json({ rule });
  } catch (error) {
    const code = String(error?.message || "");
    if (code === "TRANSFER_AMOUNT_REQUIRED") {
      return res.status(400).json({ error: "transferAmount must be greater than 0" });
    }
    if (code === "MIN_BALANCE_REQUIRED") {
      return res.status(400).json({ error: "minAvailableBalance must be 0 or greater" });
    }
    if (code === "INVALID_ACCOUNTS") {
      return res.status(400).json({ error: "sourceAccount and destinationAccount must be different" });
    }
    if (code === "SPECIFIC_DATES_REQUIRED") {
      return res.status(400).json({ error: "specific_dates schedule requires at least one valid date" });
    }
    return res.status(500).json({ error: "Failed to create automation rule" });
  }
});

router.post("/rules/:id/run", async (req, res) => {
  const user = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const ruleId = String(req.params.id || "").trim();
  if (!ruleId) {
    return res.status(400).json({ error: "Rule id is required" });
  }

  const result = await runAutomationRuleNow(user.sub, ruleId);
  return res.json({ result });
});

router.put("/rules/:id", async (req, res) => {
  const user = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const ruleId = String(req.params.id || "").trim();
  if (!ruleId) {
    return res.status(400).json({ error: "Rule id is required" });
  }

  try {
    const rule = await updateAutomationRule(user.sub, ruleId, req.body || {});
    if (!rule) {
      return res.status(404).json({ error: "Rule not found" });
    }
    return res.json({ rule });
  } catch (error) {
    const code = String(error?.message || "");
    if (code === "TRANSFER_AMOUNT_REQUIRED") {
      return res.status(400).json({ error: "transferAmount must be greater than 0" });
    }
    if (code === "MIN_BALANCE_REQUIRED") {
      return res.status(400).json({ error: "minAvailableBalance must be 0 or greater" });
    }
    if (code === "INVALID_ACCOUNTS") {
      return res.status(400).json({ error: "sourceAccount and destinationAccount must be different" });
    }
    if (code === "SPECIFIC_DATES_REQUIRED") {
      return res.status(400).json({ error: "specific_dates schedule requires at least one valid date" });
    }
    return res.status(500).json({ error: "Failed to update automation rule" });
  }
});

router.delete("/rules/:id", async (req, res) => {
  const user = await resolveUser(req);
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const ruleId = String(req.params.id || "").trim();
  if (!ruleId) {
    return res.status(400).json({ error: "Rule id is required" });
  }

  const deleted = await deleteAutomationRule(user.sub, ruleId);
  if (!deleted) {
    return res.status(404).json({ error: "Rule not found" });
  }
  return res.json({ message: "Rule deleted" });
});

export default router;
