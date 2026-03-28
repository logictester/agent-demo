import axios from "axios";

const slackWebhookUrl = String(process.env.SLACK_WEBHOOK_URL || "").trim();
const slackAlertsEnabled = String(process.env.SLACK_NOTIFY_APPROVALS || "false").trim().toLowerCase() === "true";
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

export async function sendSlackApprovalNotification(approval, user = {}) {
  if (!slackAlertsEnabled || !slackWebhookUrl || !approval?.id) {
    return false;
  }

  const link = buildApprovalLink(approval.id);
  const subject = formatApprovalSummary(approval);
  const lines = [
    "*Approval needed*",
    subject,
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
      text: `Approval needed: ${subject}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: lines.join("\n")
          }
        }
      ]
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
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: lines.join("\n")
          }
        }
      ]
    },
    { timeout: 10_000 }
  );

  return { ok: true };
}
