import axios from "axios";
import crypto from "crypto";

const slackWebhookUrl = String(process.env.SLACK_WEBHOOK_URL || "").trim();
const slackAlertsEnabled = String(process.env.SLACK_NOTIFY_APPROVALS || "false").trim().toLowerCase() === "true";
const slackSigningSecret = String(process.env.SLACK_SIGNING_SECRET || "").trim();
const frontendAppUrl = String(process.env.FRONTEND_APP_URL || "").trim().replace(/\/$/, "");

function formatApprovalSummary(approval) {
  const payload = approval?.payload || {};
  const type = String(approval?.approvalType || "approval").trim();

  if (type === "stock_trade_approval") {
    const action = String(payload.action || "trade").toUpperCase();
    const shares = Number(payload.shares) || 0;
    const symbol = String(payload.symbol || "").toUpperCase();
    const notional = Number(payload.notional || 0);
    return `${action} ${shares} ${symbol} shares for ${formatCurrency(notional)}`;
  }

  if (type === "high_risk_transfer") {
    const amount = Number(payload.amount || 0);
    const toAccount = String(payload.toAccount || "target account").trim();
    return `Transfer ${formatCurrency(amount)} to ${toAccount}`;
  }

  return String(approval?.reason || "A new approval request is pending.").trim();
}

function getApprovalPresentation(approval) {
  const payload = approval?.payload || {};
  const type = String(approval?.approvalType || "approval").trim();

  if (type === "stock_trade_approval") {
    const action = String(payload.action || "trade").toUpperCase();
    const shares = Number(payload.shares) || 0;
    const symbol = String(payload.symbol || "").toUpperCase();
    const notional = Number(payload.notional || 0);
    return {
      title: "Trading Agent Approval Needed",
      emoji: ":chart_with_upwards_trend:",
      summary: `${action} ${shares} ${symbol} shares for ${formatCurrency(notional)}`,
      details: [
        `Action: ${action}`,
        `Symbol: ${symbol || "Unknown"}`,
        `Shares: ${shares}`,
        `Estimated value: ${formatCurrency(notional)}`
      ]
    };
  }

  if (type === "high_risk_transfer") {
    const amount = Number(payload.amount || 0);
    const toAccount = String(payload.toAccount || "target account").trim();
    const fromAccount = String(payload.fromAccount || "available").trim();
    return {
      title: "Banking Approval Needed",
      emoji: ":bank:",
      summary: `Transfer ${formatCurrency(amount)} from ${fromAccount} to ${toAccount}`,
      details: [
        `Amount: ${formatCurrency(amount)}`,
        `From: ${fromAccount}`,
        `To: ${toAccount}`
      ]
    };
  }

  return {
    title: "Approval Needed",
    emoji: ":warning:",
    summary: formatApprovalSummary(approval),
    details: []
  };
}

function formatCurrency(value) {
  return `$${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function buildApprovalLink(approvalId) {
  if (!frontendAppUrl || !approvalId) {
    return "";
  }
  return `${frontendAppUrl}/?approval=${encodeURIComponent(String(approvalId))}`;
}

function buildSlackActionValue(kind, approvalId = "") {
  return JSON.stringify({
    kind,
    approvalId: String(approvalId || "").trim()
  });
}

function buildActionBlocks(kind, approvalId) {
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Approve"
          },
          style: "primary",
          action_id: "approve",
          value: buildSlackActionValue(kind, approvalId)
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Deny"
          },
          style: "danger",
          action_id: "deny",
          value: buildSlackActionValue(kind, approvalId)
        }
      ]
    }
  ];
}

function buildMessageBlocks(lines, actionBlocks = []) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n")
      }
    },
    ...actionBlocks
  ];
}

export function verifySlackSignature(rawBody, headers = {}) {
  if (!slackSigningSecret || !rawBody) {
    return false;
  }

  const timestamp = String(headers["x-slack-request-timestamp"] || "").trim();
  const signature = String(headers["x-slack-signature"] || "").trim();
  if (!timestamp || !signature) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", slackSigningSecret).update(base).digest("hex")}`;
  return (
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}

export function parseSlackInteractionPayload(payload) {
  if (!payload) {
    return null;
  }

  try {
    return typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
}

export function buildSlackInteractionResponse(title, detailLines = []) {
  return {
    response_type: "in_channel",
    replace_original: true,
    text: title,
    blocks: buildMessageBlocks([`*${title}*`, ...detailLines])
  };
}

export async function sendSlackInteractionUpdate(responseUrl, payload) {
  if (!responseUrl || !payload) {
    return false;
  }

  await axios.post(responseUrl, payload, {
    timeout: 10_000,
    headers: {
      "Content-Type": "application/json"
    }
  });

  return true;
}

export async function sendSlackApprovalNotification(approval, user = {}) {
  if (!slackAlertsEnabled || !slackWebhookUrl || !approval?.id) {
    return false;
  }

  const link = buildApprovalLink(approval.id);
  const presentation = getApprovalPresentation(approval);
  const lines = [
    `${presentation.emoji} *${presentation.title}*`,
    presentation.summary,
    ...presentation.details,
    `Type: ${approval.approvalType}`,
    `Approval ID: ${approval.id}`
  ];

  if (approval.expiresAt) {
    lines.push(`Expires: ${approval.expiresAt}`);
  }
  if (user?.email) {
    lines.push(`User: ${user.email}`);
  } else if (approval.sub) {
    lines.push(`User sub: ${approval.sub}`);
  }
  if (link) {
    lines.push(`Open app: ${link}`);
  }

  await axios.post(
    slackWebhookUrl,
    {
      text: `${presentation.title}: ${presentation.summary}`,
      blocks: buildMessageBlocks(lines, buildActionBlocks("approval", approval.id))
    },
    { timeout: 10_000 }
  );

  return true;
}

export async function sendSlackTestNotification(user = {}) {
  if (!slackAlertsEnabled || !slackWebhookUrl) {
    return {
      ok: false,
      error: "Slack notifications are disabled or the webhook URL is missing."
    };
  }

  const userLabel = String(user?.email || user?.sub || "unknown-user").trim();
  const lines = [
    "*Slack notification test*",
    "This is a demo notification from the agent app.",
    `User: ${userLabel}`
  ];

  if (frontendAppUrl) {
    lines.push(`App URL: ${frontendAppUrl}`);
  }

  await axios.post(
    slackWebhookUrl,
    {
      text: `Slack notification test for ${userLabel}`,
      blocks: buildMessageBlocks(lines, buildActionBlocks("test", ""))
    },
    { timeout: 10_000 }
  );

  return { ok: true };
}
