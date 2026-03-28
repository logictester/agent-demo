import express from "express";
import { getUserInfo } from "../services/onewelcome.js";
import { getStockDashboard, handleStockAgentMessage } from "../services/stocks.js";
import { verifyStepUpTicket } from "../services/stepup.js";

const router = express.Router();

function extractBearerToken(headerValue) {
  if (typeof headerValue !== "string") {
    return "";
  }
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function resolveUserSub(req) {
  const accessToken = extractBearerToken(req.headers.authorization);
  if (!accessToken) {
    return null;
  }

  try {
    const userInfo = await getUserInfo(accessToken);
    return userInfo?.sub || null;
  } catch {
    return null;
  }
}

function extractApprovalTicket(headerValue) {
  const value = typeof headerValue === "string" ? headerValue.trim() : "";
  return value || "";
}

router.get("/dashboard", async (req, res) => {
  const userSub = await resolveUserSub(req);
  const approvalTicket = extractApprovalTicket(req.headers["x-approval-ticket"]);
  const stepUpTicket = typeof req.headers["x-step-up-ticket"] === "string" ? req.headers["x-step-up-ticket"] : "";
  const stepUpVerified = userSub && stepUpTicket ? verifyStepUpTicket(stepUpTicket, userSub).valid : false;
  return res.json(await getStockDashboard(userSub, { stepUpVerified, approvalTicket }));
});

router.post("/agent", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    return res.status(400).json({ error: "message must be a non-empty string" });
  }

  const userSub = await resolveUserSub(req);
  const approvalTicket = extractApprovalTicket(req.headers["x-approval-ticket"]);
  const stepUpTicket = typeof req.headers["x-step-up-ticket"] === "string" ? req.headers["x-step-up-ticket"] : "";
  const stepUpVerified = userSub && stepUpTicket ? verifyStepUpTicket(stepUpTicket, userSub).valid : false;
  return res.json(await handleStockAgentMessage(userSub, message, { stepUpVerified, approvalTicket }));
});

export default router;
