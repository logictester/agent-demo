import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Ollama } from "@langchain/ollama";
import { executeSecureTransfer, parseTransferInput } from "./tools.js";
import { CAPABILITIES, POLICY, SYSTEM_PROMPT } from "./prompt.js";
import {
  applyTransferAndUpdateBalances,
  createOperationApproval,
  createTransferRecord,
  getLastTransfer,
  getTransactionHistory,
  verifyApprovedOperation
} from "../services/delegation.js";
import { createAutomationRule, listAutomationRules, runAutomationRuleNow, updateAutomationRule } from "../services/automation.js";
import { clearTaskContext, getTaskContext, upsertTaskContext } from "../services/taskContext.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "llama3.1:8b";
const agentDebug = String(process.env.AGENT_DEBUG || "").toLowerCase() === "true";

const model = new Ollama({
  baseUrl: ollamaBaseUrl,
  model: ollamaModel,
  temperature: 0
});

const KNOWN_INTENTS = new Set(CAPABILITIES.map((capability) => capability.intent));
const AUTOMATION_DRAFT_TTL_MS = 15 * 60 * 1000;
const AGENT_PLAN_MAX_STEPS = Math.max(2, Number(process.env.AGENT_PLAN_MAX_STEPS) || 6);
const OOB_APPROVAL_ENABLED = String(process.env.OOB_APPROVAL_ENABLED || "true").toLowerCase() !== "false";
const OOB_APPROVAL_TTL_SECONDS = Math.max(60, Number(process.env.OOB_APPROVAL_TTL_SECONDS) || 600);
const pendingAutomationDrafts = new Map();

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return source.slice(start, end + 1);
  }

  return "";
}

function parseIntentPayload(rawModelText) {
  const jsonText = extractJsonObject(rawModelText);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    const intent = String(parsed.intent || "").trim();
    if (!KNOWN_INTENTS.has(intent)) {
      return null;
    }

    return {
      intent,
      args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
      confidence: Number(parsed.confidence) || 0
    };
  } catch {
    return null;
  }
}

function operationForIntent(intent) {
  const capability = CAPABILITIES.find((item) => item.intent === intent);
  return capability?.operationKey || null;
}

function fallbackIntentFromQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (
    text.includes("who am i") ||
    text.includes("my name") ||
    text.includes("what is my email") ||
    text.includes("token say")
  ) {
    return "view_identity";
  }
  if (
    text.includes("risk level") ||
    text.includes("risk levels") ||
    (text.includes("risk") && text.includes("transfer")) ||
    text.includes("re-authenticate") ||
    text.includes("reauthenticate")
  ) {
    return "explain_policy";
  }
  if (
    text.includes("last transfer") ||
    text.includes("previous transfer") ||
    (text.includes("what happened") && text.includes("transfer")) ||
    (text.includes("explain") && text.includes("transfer"))
  ) {
    return "view_last_transfer";
  }
  if (
    text.includes("transaction history") ||
    text.includes("recent transactions") ||
    (text.includes("show") && text.includes("transactions")) ||
    (text.includes("list") && text.includes("transactions"))
  ) {
    return "view_transaction_history";
  }
  if (
    text.includes("auto transfer") ||
    text.includes("automated transfer") ||
    text.includes("schedule transfer") ||
    text.includes("based on current balance") ||
    text.includes("run automation") ||
    text.includes("automation rule") ||
    text.includes("edit rule") ||
    text.includes("update rule") ||
    text.includes("configure rule")
  ) {
    return "manage_automations";
  }
  if (
    text.includes("transfer") &&
    text.includes("to") &&
    (/\$?\s*\d+(?:\.\d{1,2})?/.test(text) || /\b\d+(?:\.\d{1,2})?\s*\$/.test(text))
  ) {
    return "transfer_funds";
  }
  return "general_question";
}

function buildIdentitySummary(userInfo) {
  if (!userInfo || typeof userInfo !== "object") {
    return { available: false };
  }

  return {
    available: true,
    sub: userInfo.sub || null,
    fullName:
      userInfo?.fullName?.formatted ||
      userInfo?.name ||
      [userInfo?.given_name, userInfo?.family_name].filter(Boolean).join(" ").trim() ||
      null,
    email: userInfo?.email || userInfo?.emails?.[0]?.value || null,
    exp: userInfo?.exp || null
  };
}

function localExpiryFromEpoch(exp, options = {}) {
  const value = Number(exp);
  if (!Number.isFinite(value) || value <= 0) {
    return "not available";
  }
  const clientTimeZone = String(options.clientTimeZone || "").trim();
  const clientLocale = String(options.clientLocale || "").trim();
  const formatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short"
  };
  if (clientTimeZone) {
    formatOptions.timeZone = clientTimeZone;
  }

  try {
    return new Date(value * 1000).toLocaleString(clientLocale || undefined, formatOptions);
  } catch {
    return new Date(value * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short"
    });
  }
}

function localDateTimeFromIso(isoValue, options = {}) {
  const raw = String(isoValue || "").trim();
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const clientTimeZone = String(options.clientTimeZone || "").trim();
  const clientLocale = String(options.clientLocale || "").trim();
  const formatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short"
  };
  if (clientTimeZone) {
    formatOptions.timeZone = clientTimeZone;
  }
  try {
    return date.toLocaleString(clientLocale || undefined, formatOptions);
  } catch {
    return date.toLocaleString(undefined, formatOptions);
  }
}

function formatRuleForResponse(rule, options = {}) {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  return {
    id: rule.id || null,
    name: rule.name || null,
    sourceAccount: rule.sourceAccount || null,
    destinationAccount: rule.destinationAccount || null,
    transferAmount: Number(rule.transferAmount),
    minAvailableBalance: Number(rule.minAvailableBalance),
    mode: rule.mode || null,
    scheduleType: rule.scheduleType || null,
    scheduleConfig: rule.scheduleConfig || {},
    adaptiveConfig: rule.adaptiveConfig || { rules: [] },
    enabled: Boolean(rule.enabled),
    nextRunLocal: localDateTimeFromIso(rule.nextRunAt, options),
    lastRunLocal: localDateTimeFromIso(rule.lastRunAt, options),
    createdAtLocal: localDateTimeFromIso(rule.createdAt, options),
    updatedAtLocal: localDateTimeFromIso(rule.updatedAt, options)
  };
}

async function classifyIntent(userQuestion, context) {
  const prompt = `${SYSTEM_PROMPT}
Your task: classify the user's request into one intent and arguments.
Return JSON only with this exact schema:
{"intent":"<intent>","args":{},"confidence":0.0}

Allowed intents:
${JSON.stringify(CAPABILITIES, null, 2)}

Policy:
${JSON.stringify(POLICY)}

Context:
${JSON.stringify(context)}

User question:
${userQuestion}
`;

  const raw = await model.invoke(prompt);
  if (agentDebug) {
    console.log(`[agent-trace] intent_raw=${String(raw).slice(0, 400)}`);
  }
  return parseIntentPayload(raw);
}

function parseExecutionPlanPayload(rawModelText) {
  const jsonText = extractJsonObject(rawModelText);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    const steps = Array.isArray(parsed?.steps)
      ? parsed.steps
          .map((step) => ({
            tool: String(step?.tool || "").trim().toLowerCase(),
            purpose: String(step?.purpose || "").trim()
          }))
          .filter((step) => step.tool && step.purpose)
      : [];
    const needsClarification = Boolean(parsed?.needsClarification);
    const clarificationQuestion = String(parsed?.clarificationQuestion || "").trim();
    return { steps, needsClarification, clarificationQuestion };
  } catch {
    return null;
  }
}

async function buildExecutionPlan(userQuestion, context, intentPayload) {
  const prompt = `${SYSTEM_PROMPT}
You are an execution planner for a banking assistant.
Return JSON only with this schema:
{
  "steps":[{"tool":"string","purpose":"string"}],
  "needsClarification":false,
  "clarificationQuestion":""
}

Rules:
- Keep plans short and safe (max ${AGENT_PLAN_MAX_STEPS} steps).
- Allowed tool names:
  classify_intent, load_context, check_delegation, parse_transfer, evaluate_risk,
  execute_transfer, load_identity, load_history, manage_automation_draft, run_automation_rule,
  explain_policy, synthesize_response
- If key details are missing and intent is operational, set needsClarification=true with a concise question.
- Never include markdown.

Intent:
${JSON.stringify(intentPayload || {}, null, 2)}

Context:
${JSON.stringify(context || {}, null, 2)}

User question:
${String(userQuestion || "")}
`;

  const raw = await model.invoke(prompt);
  const parsed = parseExecutionPlanPayload(raw);
  if (!parsed) {
    return {
      steps: [
        { tool: "load_context", purpose: "Load available policy and user context." },
        { tool: "synthesize_response", purpose: "Return a grounded response." }
      ],
      needsClarification: false,
      clarificationQuestion: ""
    };
  }

  const steps = parsed.steps.slice(0, AGENT_PLAN_MAX_STEPS);
  if (!steps.length) {
    steps.push(
      { tool: "load_context", purpose: "Load available policy and user context." },
      { tool: "synthesize_response", purpose: "Return a grounded response." }
    );
  }
  return {
    steps,
    needsClarification: parsed.needsClarification,
    clarificationQuestion: parsed.clarificationQuestion
  };
}

async function synthesizeResponse(userQuestion, facts) {
  const prompt = `${SYSTEM_PROMPT}
Generate a concise user-facing response using only the trusted facts below.
Do not invent facts not present here.

User question: ${userQuestion}
Trusted facts:
${JSON.stringify(facts, null, 2)}
`;
  const raw = await model.invoke(prompt);
  const output = String(raw || "").trim();
  return output || "I could not generate a response.";
}

function delegationBlock(userInfo, delegation, operationKey) {
  if (!operationKey) {
    return null;
  }
  if (!userInfo?.sub) {
    return "This action requires authentication and delegation. Please sign in, complete IDV verification, and delegate this operation first.";
  }
  if (!delegation?.idvVerified) {
    return "Action blocked: IDV verification is required before the agent can act on your behalf.";
  }
  if (!Array.isArray(delegation.delegatedOperations) || !delegation.delegatedOperations.includes(operationKey)) {
    return `Action blocked: the agent is not delegated to perform '${operationKey}'. Please update your delegation settings.`;
  }
  return null;
}

function transferRiskTier(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return "Low";
  }
  if (value > Number(POLICY.highRiskTransferThreshold)) {
    return "High";
  }
  if (value > Number(POLICY.mediumRiskTransferThreshold || POLICY.highRiskTransferThreshold)) {
    return "Medium";
  }
  return "Low";
}

function validateTransferAgainstDelegationConstraints(delegation, transferAmount, purpose) {
  const constraints = delegation?.constraints && typeof delegation.constraints === "object"
    ? delegation.constraints
    : {};
  const nowMs = Date.now();
  const expiresAtRaw = String(constraints.expiresAt || "").trim();
  if (expiresAtRaw) {
    const expiresAt = new Date(expiresAtRaw).getTime();
    if (Number.isFinite(expiresAt) && nowMs >= expiresAt) {
      return {
        ok: false,
        reason: "Delegation has expired. Please renew delegation settings."
      };
    }
  }

  const allowedPurposes = Array.isArray(constraints.purposes)
    ? constraints.purposes.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const fallbackPurpose = String(constraints.purpose || "").trim();
  const purposeSet = new Set(allowedPurposes.length ? allowedPurposes : fallbackPurpose ? [fallbackPurpose] : []);
  if (purposeSet.size > 0 && purpose && !purposeSet.has(purpose)) {
    return {
      ok: false,
      reason: `Delegation purpose mismatch. Allowed purposes: ${Array.from(purposeSet).join(", ")}.`
    };
  }

  const maxTransferAmount = Number(constraints.maxTransferAmount);
  if (Number.isFinite(maxTransferAmount) && maxTransferAmount > 0 && Number(transferAmount) > maxTransferAmount) {
    return {
      ok: false,
      reason: `Delegation limit exceeded. Max transfer amount is ${maxTransferAmount.toFixed(2)}.`
    };
  }

  return { ok: true };
}

function transferArgsFromIntentArgs(args, originalMessage) {
  const amount = Number(args?.amount);
  const toAccount = String(args?.toAccount || "").trim();
  const fromAccount = String(args?.fromAccount || "").trim();
  if (Number.isFinite(amount) && amount > 0 && toAccount) {
    return { amount, toAccount, fromAccount: fromAccount || null };
  }
  return parseTransferInput(originalMessage);
}

function draftKeyForUser(userSub) {
  return String(userSub || "").trim() || "anonymous";
}

function draftKeysForUser(userSubOrKeys) {
  const source = Array.isArray(userSubOrKeys) ? userSubOrKeys : [userSubOrKeys];
  const keys = source
    .map((item) => draftKeyForUser(item))
    .filter(Boolean);
  return Array.from(new Set(keys));
}

async function getPendingAutomationDraft(userSubOrKeys) {
  const keys = draftKeysForUser(userSubOrKeys);
  for (const key of keys) {
    try {
      const persisted = await getTaskContext(key, "automation_draft");
      if (persisted && typeof persisted === "object") {
        return { ...persisted, updatedAtMs: Date.now() };
      }
    } catch {
      // Fall through to in-memory lookup.
    }

    const memoryRecord = pendingAutomationDrafts.get(key);
    if (!memoryRecord) {
      continue;
    }
    if (Date.now() - Number(memoryRecord.updatedAtMs || 0) > AUTOMATION_DRAFT_TTL_MS) {
      pendingAutomationDrafts.delete(key);
      continue;
    }
    return memoryRecord;
  }
  return null;
}

async function setPendingAutomationDraft(userSubOrKeys, record) {
  const keys = draftKeysForUser(userSubOrKeys);
  const value = { ...record, updatedAtMs: Date.now() };
  for (const key of keys) {
    pendingAutomationDrafts.set(key, value);
    try {
      await upsertTaskContext(key, value, {
        contextType: "automation_draft",
        ttlSeconds: Math.floor(AUTOMATION_DRAFT_TTL_MS / 1000)
      });
    } catch {
      // In-memory fallback remains active.
    }
  }
}

async function clearPendingAutomationDraft(userSubOrKeys) {
  const keys = draftKeysForUser(userSubOrKeys);
  for (const key of keys) {
    pendingAutomationDrafts.delete(key);
    try {
      await clearTaskContext(key, "automation_draft");
    } catch {
      // Ignore clear failures.
    }
  }
}

function normalizeAutomationAccount(value, fallback = "available") {
  const text = String(value || "").toLowerCase();
  if (text.includes("saving")) {
    return "savings";
  }
  if (text.includes("available") || text.includes("balance") || text.includes("checking")) {
    return "available";
  }
  return fallback;
}

function oppositeAutomationAccount(account) {
  return account === "savings" ? "available" : "savings";
}

function mergeAutomationDraft(base = {}, incoming = {}, intentArgs = {}, explicit = {}) {
  const next = { ...(base && typeof base === "object" ? base : {}) };
  const data = {
    ...(incoming && typeof incoming === "object" ? incoming : {}),
    ...(intentArgs && typeof intentArgs === "object" ? intentArgs : {})
  };

  if (String(data.name || "").trim()) {
    next.name = String(data.name).trim();
  } else if (String(data.ruleName || "").trim()) {
    next.name = String(data.ruleName).trim();
  }
  const transferAmount = Number(data.transferAmount);
  if (Number.isFinite(transferAmount) && transferAmount > 0 && explicit.transferAmount) {
    next.transferAmount = Number(transferAmount.toFixed(2));
  }
  const minAvailableBalance = Number(data.minAvailableBalance);
  if (Number.isFinite(minAvailableBalance) && minAvailableBalance >= 0 && explicit.minAvailableBalance) {
    next.minAvailableBalance = Number(minAvailableBalance.toFixed(2));
  }
  if (data.sourceAccount != null && (explicit.sourceAccount || !next.sourceAccount)) {
    next.sourceAccount = normalizeAutomationAccount(data.sourceAccount, next.sourceAccount || "available");
  } else if (!next.sourceAccount) {
    next.sourceAccount = "available";
  }
  if (data.destinationAccount != null && (explicit.destinationAccount || !next.destinationAccount)) {
    next.destinationAccount = normalizeAutomationAccount(data.destinationAccount, next.destinationAccount || "savings");
  } else if (!next.destinationAccount) {
    next.destinationAccount = "savings";
  }
  const modeSource = explicit.mode || !next.mode ? data.mode : next.mode;
  const modeRaw = String(modeSource || next.mode || "").toLowerCase();
  next.mode = modeRaw === "on_demand" ? "on_demand" : "scheduled";
  const scheduleTypeSource = explicit.scheduleType || !next.scheduleType ? data.scheduleType : next.scheduleType;
  const scheduleTypeRaw = String(scheduleTypeSource || next.scheduleType || "").toLowerCase();
  next.scheduleType = ["hourly", "daily", "weekly_n_times", "custom_interval", "specific_dates"].includes(scheduleTypeRaw)
    ? scheduleTypeRaw
    : next.mode === "scheduled"
      ? "daily"
      : "custom_interval";

  const scheduleConfig = { ...(next.scheduleConfig && typeof next.scheduleConfig === "object" ? next.scheduleConfig : {}) };
  const incomingScheduleConfig = data.scheduleConfig && typeof data.scheduleConfig === "object" ? data.scheduleConfig : {};
  if (Number.isFinite(Number(data.intervalMinutes)) && Number(data.intervalMinutes) > 0) {
    scheduleConfig.intervalMinutes = Math.floor(Number(data.intervalMinutes));
  }
  if (Number.isFinite(Number(incomingScheduleConfig.intervalMinutes)) && Number(incomingScheduleConfig.intervalMinutes) > 0) {
    scheduleConfig.intervalMinutes = Math.floor(Number(incomingScheduleConfig.intervalMinutes));
  }
  if (Number.isFinite(Number(data.timesPerWeek)) && Number(data.timesPerWeek) > 0) {
    scheduleConfig.timesPerWeek = Math.floor(Number(data.timesPerWeek));
  }
  if (Number.isFinite(Number(incomingScheduleConfig.timesPerWeek)) && Number(incomingScheduleConfig.timesPerWeek) > 0) {
    scheduleConfig.timesPerWeek = Math.floor(Number(incomingScheduleConfig.timesPerWeek));
  }
  const dates = Array.isArray(incomingScheduleConfig.dates) ? incomingScheduleConfig.dates : [];
  if (dates.length) {
    scheduleConfig.dates = dates.map((date) => String(date || "").trim()).filter(Boolean);
  }
  next.scheduleConfig = scheduleConfig;

  const adaptiveInput = data.adaptiveConfig && typeof data.adaptiveConfig === "object" ? data.adaptiveConfig : {};
  const adaptiveRules = Array.isArray(adaptiveInput.rules) ? adaptiveInput.rules : [];
  if (adaptiveRules.length) {
    next.adaptiveConfig = {
      rules: adaptiveRules
        .map((rule) => ({
          whenBalanceBelow: Number(rule?.whenBalanceBelow),
          transferAmount: Number(rule?.transferAmount)
        }))
        .filter(
          (rule) =>
            Number.isFinite(rule.whenBalanceBelow) &&
            rule.whenBalanceBelow >= 0 &&
            Number.isFinite(rule.transferAmount) &&
            rule.transferAmount > 0
        )
        .map((rule) => ({
          whenBalanceBelow: Number(rule.whenBalanceBelow.toFixed(2)),
          transferAmount: Number(rule.transferAmount.toFixed(2))
        }))
    };
  } else if (!next.adaptiveConfig) {
    next.adaptiveConfig = { rules: [] };
  }

  return next;
}

function extractShorthandAutomationInput(message, draft = {}, missing = []) {
  const text = String(message || "").trim();
  if (!text) {
    return {};
  }
  const lower = text.toLowerCase();
  const result = { scheduleConfig: {}, adaptiveConfig: { rules: [] } };

  const numericOnlyMatch = text.match(/^\$?\s*(\d+(?:\.\d{1,2})?)\s*$/);
  if (numericOnlyMatch) {
    const value = Number(numericOnlyMatch[1]);
    const numericPriority = ["transferAmount", "minAvailableBalance", "intervalMinutes", "timesPerWeek"];
    const target = numericPriority.find((field) => missing.includes(field));
    if (target === "transferAmount") {
      result.transferAmount = value;
    } else if (target === "minAvailableBalance") {
      result.minAvailableBalance = value;
    } else if (target === "intervalMinutes") {
      result.scheduleConfig.intervalMinutes = Math.floor(value);
    } else if (target === "timesPerWeek") {
      result.scheduleConfig.timesPerWeek = Math.floor(value);
    }
  }

  const parsedAccount = normalizeAutomationAccount(lower, "");
  if (parsedAccount) {
    const sourceMissing = missing.includes("sourceAccount");
    const destinationMissing = missing.includes("destinationAccount");
    if (sourceMissing && !destinationMissing) {
      result.sourceAccount = parsedAccount;
    } else if (!sourceMissing && destinationMissing) {
      result.destinationAccount = parsedAccount;
    } else if (sourceMissing && destinationMissing) {
      result.destinationAccount = parsedAccount;
      result.sourceAccount = oppositeAutomationAccount(parsedAccount);
    } else if (missing.includes("differentAccounts")) {
      if (draft.sourceAccount === draft.destinationAccount && draft.sourceAccount) {
        result.destinationAccount = oppositeAutomationAccount(draft.sourceAccount);
      }
    }
  }

  if (missing.includes("mode")) {
    if (/\bon[\s-]?demand\b/.test(lower)) {
      result.mode = "on_demand";
    } else if (/\b(?:scheduled|schedule|every|weekly|daily|hourly)\b/.test(lower)) {
      result.mode = "scheduled";
    }
  }

  if (missing.includes("scheduleType")) {
    if (/\bweekly\b|\bonce a week\b|\bevery week\b/.test(lower)) {
      result.scheduleType = "weekly_n_times";
      result.scheduleConfig.timesPerWeek = 1;
    } else if (/\bdaily\b|\bevery day\b/.test(lower)) {
      result.scheduleType = "daily";
    } else if (/\bhourly\b|\bevery hour\b/.test(lower)) {
      result.scheduleType = "hourly";
    } else if (/\bspecific dates?\b/.test(lower)) {
      result.scheduleType = "specific_dates";
    } else if (/\binterval\b|\bevery\s+\d+\s*(?:minute|minutes|hour|hours|day|days)\b/.test(lower)) {
      result.scheduleType = "custom_interval";
    }
  }

  const intervalMatch = text.match(/\bevery\s+(\d+)\s*(minute|minutes|hour|hours|day|days)\b/i);
  if (intervalMatch) {
    const base = Number(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    let minutes = base;
    if (unit.startsWith("hour")) {
      minutes = base * 60;
    } else if (unit.startsWith("day")) {
      minutes = base * 60 * 24;
    }
    result.scheduleType = result.scheduleType || "custom_interval";
    result.scheduleConfig.intervalMinutes = minutes;
  }

  const timesPerWeekMatch = text.match(/(\d+)\s+times?\s+(?:per|a)\s+week/i);
  if (timesPerWeekMatch) {
    result.scheduleType = "weekly_n_times";
    result.scheduleConfig.timesPerWeek = Number(timesPerWeekMatch[1]);
  }

  if (missing.includes("scheduleDates")) {
    const dateLike = text
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((value) => Number.isFinite(new Date(value).getTime()));
    if (dateLike.length) {
      result.scheduleType = "specific_dates";
      result.scheduleConfig.dates = dateLike;
    }
  }

  if (missing.includes("name") && text.length >= 2 && text.length <= 80 && !numericOnlyMatch) {
    result.name = text;
  }

  return result;
}

function extractAutomationFieldsFromText(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const out = {
    scheduleConfig: {},
    adaptiveConfig: { rules: [] }
  };

  const transferAmountMatch =
    text.match(/\btransfer\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\bamount\s*(?:to|is|=)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\bmove\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
  if (transferAmountMatch) {
    out.transferAmount = Number(transferAmountMatch[1]);
  }

  const minBalanceMatch = text.match(
    /\b(?:minimum\s+)?(?:balance|available(?:\s+balance)?)(?:\s+threshold)?\s*(?:is|=|:)?\s*(?:above|over|>=|greater than|higher than)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i
  );
  if (minBalanceMatch) {
    out.minAvailableBalance = Number(minBalanceMatch[1]);
  }

  const fromToMatch = text.match(/\bfrom\s+([a-z\s]+?)\s+to\s+([a-z\s]+)\b/i);
  if (fromToMatch) {
    out.sourceAccount = normalizeAutomationAccount(fromToMatch[1], "available");
    out.destinationAccount = normalizeAutomationAccount(fromToMatch[2], "savings");
  } else {
    if (/\bfrom\s+(?:available|balance|checking)\b/i.test(text)) {
      out.sourceAccount = "available";
    } else if (/\bfrom\s+savings?\b/i.test(text)) {
      out.sourceAccount = "savings";
    }
    if (/\bto\s+(?:available|balance|checking)\b/i.test(text)) {
      out.destinationAccount = "available";
    } else if (/\bto\s+savings?\b/i.test(text)) {
      out.destinationAccount = "savings";
    }
  }

  if (lower.includes("on demand") || lower.includes("ondemand")) {
    out.mode = "on_demand";
  } else if (lower.includes("schedule") || lower.includes("every") || lower.includes("once")) {
    out.mode = "scheduled";
  }

  if (/\bonce\s+a\s+week\b/i.test(text) || /\bevery\s+week\b/i.test(text) || /\bweekly\b/i.test(text)) {
    out.scheduleType = "weekly_n_times";
    out.scheduleConfig.timesPerWeek = 1;
  } else if (/\bevery\s+day\b/i.test(text) || /\bdaily\b/i.test(text)) {
    out.scheduleType = "daily";
  } else if (/\bevery\s+hour\b/i.test(text) || /\bhourly\b/i.test(text)) {
    out.scheduleType = "hourly";
  } else {
    const intervalMatch = text.match(/\bevery\s+(\d+)\s*(minute|minutes|hour|hours|day|days)\b/i);
    if (intervalMatch) {
      const base = Number(intervalMatch[1]);
      const unit = intervalMatch[2].toLowerCase();
      let minutes = base;
      if (unit.startsWith("hour")) {
        minutes = base * 60;
      } else if (unit.startsWith("day")) {
        minutes = base * 60 * 24;
      }
      out.scheduleType = "custom_interval";
      out.scheduleConfig.intervalMinutes = minutes;
    }
  }

  const timesPerWeekMatch = text.match(/(\d+)\s+times?\s+(?:per|a)\s+week/i);
  if (timesPerWeekMatch) {
    out.scheduleType = "weekly_n_times";
    out.scheduleConfig.timesPerWeek = Number(timesPerWeekMatch[1]);
  }

  const nameMatch = text.match(/\b(?:named|name)\s+["']?([^"']{2,60})["']?/i);
  if (nameMatch) {
    out.name = String(nameMatch[1]).trim();
  }

  const adaptivePattern = /below\s*\$?\s*(\d+(?:\.\d{1,2})?).{0,40}?(?:to|amount)\s*\$?\s*(\d+(?:\.\d{1,2})?)/gi;
  let adaptiveMatch = adaptivePattern.exec(text);
  while (adaptiveMatch) {
    out.adaptiveConfig.rules.push({
      whenBalanceBelow: Number(adaptiveMatch[1]),
      transferAmount: Number(adaptiveMatch[2])
    });
    adaptiveMatch = adaptivePattern.exec(text);
  }

  return out;
}

function getAutomationDraftMissing(draft = {}) {
  const missing = [];
  if (!Number.isFinite(Number(draft.transferAmount)) || Number(draft.transferAmount) <= 0) {
    missing.push("transferAmount");
  }
  if (!Number.isFinite(Number(draft.minAvailableBalance)) || Number(draft.minAvailableBalance) < 0) {
    missing.push("minAvailableBalance");
  }
  if (!draft.sourceAccount) {
    missing.push("sourceAccount");
  }
  if (!draft.destinationAccount) {
    missing.push("destinationAccount");
  }
  if (draft.sourceAccount && draft.destinationAccount && draft.sourceAccount === draft.destinationAccount) {
    missing.push("differentAccounts");
  }
  if (String(draft.mode || "scheduled") === "scheduled") {
    if (!draft.scheduleType) {
      missing.push("scheduleType");
    } else if (draft.scheduleType === "weekly_n_times") {
      const timesPerWeek = Number(draft.scheduleConfig?.timesPerWeek);
      if (!Number.isFinite(timesPerWeek) || timesPerWeek <= 0) {
        missing.push("timesPerWeek");
      }
    } else if (draft.scheduleType === "custom_interval") {
      const intervalMinutes = Number(draft.scheduleConfig?.intervalMinutes);
      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        missing.push("intervalMinutes");
      }
    } else if (draft.scheduleType === "specific_dates") {
      const dates = Array.isArray(draft.scheduleConfig?.dates) ? draft.scheduleConfig.dates : [];
      if (!dates.length) {
        missing.push("scheduleDates");
      }
    }
  }
  return missing;
}

function formatMissingAutomationQuestion(missing = []) {
  const labels = {
    transferAmount: "transfer amount",
    minAvailableBalance: "minimum balance threshold",
    sourceAccount: "source account (available or savings)",
    destinationAccount: "destination account (available or savings)",
    differentAccounts: "different source and destination accounts",
    scheduleType: "schedule type (hourly, daily, weekly, custom interval, or specific dates)",
    timesPerWeek: "times per week",
    intervalMinutes: "custom interval in minutes",
    scheduleDates: "one or more specific execution dates"
  };
  const items = missing.map((item) => labels[item] || item);
  if (!items.length) {
    return "Please provide additional automation details.";
  }
  return `I need a bit more information to configure this rule: ${items.join(", ")}.`;
}

function parseAutomationAssistantPayload(rawModelText) {
  const jsonText = extractJsonObject(rawModelText);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    const action = String(parsed.action || "").trim().toLowerCase();
    return {
      action,
      targetRuleName: String(parsed.targetRuleName || "").trim() || null,
      question: String(parsed.question || "").trim() || null,
      missing: Array.isArray(parsed.missing)
        ? parsed.missing.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      draft: parsed.draft && typeof parsed.draft === "object" ? parsed.draft : {}
    };
  } catch {
    return null;
  }
}

async function parseAutomationRequestWithAi(message, { intentArgs = {}, pendingDraft = null, rules = [] } = {}) {
  const prompt = `${SYSTEM_PROMPT}
You are extracting banking automation rule operations from user text.
Return JSON only with this schema:
{
  "action":"create_rule|update_rule|run_rule|list_rules|cancel|continue_draft|unknown",
  "targetRuleName":"string or empty",
  "draft":{
    "name":"string",
    "transferAmount":0,
    "minAvailableBalance":0,
    "sourceAccount":"available|savings",
    "destinationAccount":"available|savings",
    "mode":"scheduled|on_demand",
    "scheduleType":"hourly|daily|weekly_n_times|custom_interval|specific_dates",
    "scheduleConfig":{"timesPerWeek":0,"intervalMinutes":0,"dates":[]},
    "adaptiveConfig":{"rules":[{"whenBalanceBelow":0,"transferAmount":0}]}
  },
  "missing":["fieldName"],
  "question":"follow-up question when missing info is required"
}

Rules:
- "once a week" => scheduleType weekly_n_times with timesPerWeek 1.
- "every day" => daily. "every hour" => hourly.
- If user asks to lower transfer when balance drops below thresholds, put that in adaptiveConfig.rules.
- If this message is a follow-up to a pending draft, use action "continue_draft".
- If user asks to edit/change an existing rule, use action "update_rule" and targetRuleName if present.

Existing pending draft:
${JSON.stringify(pendingDraft || null, null, 2)}

Intent args:
${JSON.stringify(intentArgs || {}, null, 2)}

Existing rules:
${JSON.stringify(rules.map((rule) => ({ id: rule.id, name: rule.name, mode: rule.mode })), null, 2)}

User message:
${message}
`;

  const raw = await model.invoke(prompt);
  if (agentDebug) {
    console.log(`[agent-trace] automation_parse_raw=${String(raw).slice(0, 500)}`);
  }
  return parseAutomationAssistantPayload(raw);
}

function findRuleByName(rules, name) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) {
    return null;
  }
  return (
    rules.find((rule) => String(rule.name || "").trim().toLowerCase() === target) ||
    rules.find((rule) => String(rule.name || "").trim().toLowerCase().includes(target)) ||
    null
  );
}

function fallbackAutomationActionFromMessage(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("cancel")) {
    return "cancel";
  }
  if (text.includes("list") && text.includes("rule")) {
    return "list_rules";
  }
  if ((text.includes("run") || text.includes("execute")) && text.includes("rule")) {
    return "run_rule";
  }
  if (text.includes("run automation")) {
    return "run_rule";
  }
  if (text.includes("update") || text.includes("edit")) {
    return "update_rule";
  }
  if (text.includes("create") || text.includes("schedule") || text.includes("configure")) {
    return "create_rule";
  }
  return "unknown";
}

function isAffirmativeResponse(message) {
  const text = String(message || "").trim().toLowerCase();
  return [
    "yes",
    "y",
    "confirm",
    "confirmed",
    "proceed",
    "ok",
    "okay",
    "create it",
    "do it"
  ].includes(text);
}

function isNegativeResponse(message) {
  const text = String(message || "").trim().toLowerCase();
  return ["no", "n", "cancel", "stop", "don't", "do not"].includes(text);
}

function scheduleSummaryFromDraft(draft = {}) {
  const mode = String(draft.mode || "scheduled");
  if (mode === "on_demand") {
    return "On-demand";
  }
  const type = String(draft.scheduleType || "daily");
  if (type === "hourly") {
    return "Every hour";
  }
  if (type === "daily") {
    return "Every day";
  }
  if (type === "weekly_n_times") {
    return `${Number(draft.scheduleConfig?.timesPerWeek || 1)} time(s) per week`;
  }
  if (type === "specific_dates") {
    const count = Array.isArray(draft.scheduleConfig?.dates) ? draft.scheduleConfig.dates.length : 0;
    return count ? `${count} specific date(s)` : "Specific dates";
  }
  return `Every ${Number(draft.scheduleConfig?.intervalMinutes || 1440)} minute(s)`;
}

function buildCreationPreview(draft = {}) {
  const name = String(draft.name || "New automation rule");
  const fromAccount = String(draft.sourceAccount || "available");
  const toAccount = String(draft.destinationAccount || "savings");
  const amount = Number(draft.transferAmount || 0).toFixed(2);
  const minBalance = Number(draft.minAvailableBalance || 0).toFixed(2);
  const schedule = scheduleSummaryFromDraft(draft);
  const adaptiveRules = Array.isArray(draft.adaptiveConfig?.rules) ? draft.adaptiveConfig.rules : [];
  const adaptiveLine = adaptiveRules.length
    ? `Adaptive rules: ${adaptiveRules.map((rule) => `if balance <= ${Number(rule.whenBalanceBelow).toFixed(2)} then transfer ${Number(rule.transferAmount).toFixed(2)}`).join("; ")}.`
    : "Adaptive rules: none.";
  return `Please confirm rule creation:
- Name: ${name}
- Transfer: ${amount} from ${fromAccount} to ${toAccount}
- Minimum available balance: ${minBalance}
- Schedule: ${schedule}
- ${adaptiveLine}
Reply "yes" to create or "cancel" to abort.`;
}

export async function runAgent(message, options = {}) {
  const userInfo = options.userInfo || null;
  const userSub = options.userSub || userInfo?.sub || null;
  const conversationKey = options.conversationKey || userSub || userInfo?.sub || null;
  const draftKeys = [conversationKey, userSub];
  const tokenVerified = Boolean(options.tokenVerified);
  const stepUpVerified = Boolean(options.stepUpVerified);
  const approvalTicket = String(options.approvalTicket || "").trim();
  const clientTimeZone = options.clientTimeZone || "";
  const clientLocale = options.clientLocale || "";
  const delegation = options.delegation || { idvVerified: false, delegatedOperations: [] };
  const lastTransfer = userSub ? await getLastTransfer(userSub) : null;
  const recentTransactions = userSub ? await getTransactionHistory(userSub, 5) : [];

  const context = {
    policy: POLICY,
    tokenVerified,
    identity: buildIdentitySummary(userInfo),
    delegation,
    lastTransfer,
    recentTransactions
  };

  const classified =
    (await classifyIntent(message, context)) || { intent: "general_question", args: {}, confidence: 0 };
  const fallbackIntent = fallbackIntentFromQuestion(message);
  const pendingAutomation = await getPendingAutomationDraft(draftKeys);
  const intentPayload =
    pendingAutomation
      ? { ...classified, intent: "manage_automations" }
      : classified.intent === "general_question" && fallbackIntent !== "general_question"
      ? { ...classified, intent: fallbackIntent }
      : classified;
  const operationKey = operationForIntent(intentPayload.intent);
  const executionPlan = await buildExecutionPlan(message, context, intentPayload);
  const plannedSteps = Array.isArray(executionPlan.steps) ? executionPlan.steps.slice(0, AGENT_PLAN_MAX_STEPS) : [];
  const baseDecisionFlow = [
    "Parsed your request.",
    `Detected intent: ${intentPayload.intent}.`,
    `Planner produced ${plannedSteps.length} step(s) with max budget ${AGENT_PLAN_MAX_STEPS}.`,
    ...plannedSteps.map((step, index) => `Plan ${index + 1}: ${step.tool} - ${step.purpose}`),
    pendingAutomation ? "Resumed pending automation configuration context." : "No pending automation context.",
    operationKey ? `Mapped intent to operation: ${operationKey}.` : "No privileged operation required."
  ];

  function buildResult(payload, operationPerformed = false) {
    return {
      ...payload,
      intent: intentPayload.intent,
      operationKey: operationKey || null,
      operationPerformed: Boolean(operationPerformed)
    };
  }

  if (agentDebug) {
    console.log(
      `[agent-trace] intent=${intentPayload.intent} op=${operationKey || "none"} confidence=${intentPayload.confidence}`
    );
  }

  if (
    executionPlan?.needsClarification &&
    executionPlan?.clarificationQuestion &&
    intentPayload.intent !== "general_question" &&
    !pendingAutomation
  ) {
    return buildResult({
      decisionFlow: [...baseDecisionFlow, "Planner requested clarification before execution."],
      output: executionPlan.clarificationQuestion,
      transfer: null,
      riskStatus: "Normal",
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
    });
  }

  const blockedReason = delegationBlock(userInfo, delegation, operationKey);
  if (blockedReason) {
    if (intentPayload.intent === "transfer_funds") {
      await createTransferRecord(userSub, {
        status: "blocked",
        amount: null,
        toAccount: null,
        riskStatus: "Normal",
        requiresStepUp: false,
        stepUpVerified: false,
        details: { blockedReason }
      });
    }
    const output = await synthesizeResponse(message, {
      status: "blocked",
      reason: blockedReason
    });
    return buildResult({
      decisionFlow: [...baseDecisionFlow, `Blocked by policy: ${blockedReason}`],
      output,
      transfer: null,
      riskStatus: "Normal",
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
    });
  }

  if (intentPayload.intent === "transfer_funds") {
    const parsedTransfer = transferArgsFromIntentArgs(intentPayload.args, message);
    if (parsedTransfer.error) {
      await createTransferRecord(userSub, {
        status: "failed",
        amount: null,
        toAccount: null,
        riskStatus: "Normal",
        requiresStepUp: false,
        stepUpVerified,
        details: { error: parsedTransfer.error }
      });
      const output = await synthesizeResponse(message, {
        status: "error",
        reason: parsedTransfer.error
      });
      return buildResult({
        decisionFlow: [...baseDecisionFlow, `Transfer parsing failed: ${parsedTransfer.error}`],
        output,
        transfer: null,
        riskStatus: "Normal",
        riskTier: "Low",
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }

    const riskTier = transferRiskTier(parsedTransfer.amount);
    const riskStatus = riskTier === "High" ? "High" : "Normal";
    const delegatedPurposes = Array.isArray(delegation?.constraints?.purposes)
      ? delegation.constraints.purposes
      : [];
    const requestedPurpose = String(
      intentPayload.args?.purpose ||
        delegatedPurposes[0] ||
        delegation?.constraints?.purpose ||
        "general_assistance"
    );
    const delegationConstraintCheck = validateTransferAgainstDelegationConstraints(
      delegation,
      parsedTransfer.amount,
      requestedPurpose
    );
    if (!delegationConstraintCheck.ok) {
      await createTransferRecord(userSub, {
        status: "blocked",
        amount: parsedTransfer.amount,
        toAccount: parsedTransfer.toAccount,
        riskStatus,
        requiresStepUp: riskTier !== "Low",
        stepUpVerified,
        details: { reason: "delegation_constraints", message: delegationConstraintCheck.reason }
      });
      return buildResult({
        decisionFlow: [...baseDecisionFlow, `Transfer blocked by delegation constraints: ${delegationConstraintCheck.reason}`],
        output: delegationConstraintCheck.reason,
        transfer: null,
        riskStatus,
        riskTier,
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }

    if (riskTier !== "Low" && !stepUpVerified) {
      await createTransferRecord(userSub, {
        status: "blocked",
        amount: parsedTransfer.amount,
        toAccount: parsedTransfer.toAccount,
        riskStatus,
        requiresStepUp: true,
        stepUpVerified,
        details: { reason: "step_up_required" }
      });
      const output = await synthesizeResponse(message, {
        status: "reauth_required",
        reason:
          riskTier === "High"
            ? `High-risk transfer (>${POLICY.highRiskTransferThreshold}) requires OneWelcome re-authentication.`
            : `Medium-risk transfer (>${POLICY.mediumRiskTransferThreshold}) requires OneWelcome re-authentication.`
      });
      return buildResult({
        decisionFlow: [
          ...baseDecisionFlow,
          `Validated amount: ${parsedTransfer.amount}.`,
          `Risk check: ${riskTier}.`,
          "Step-up authentication required before execution."
        ],
        output,
        transfer: null,
        riskStatus,
        riskTier,
        requiresReauth: true,
        reauthUrl: "/auth/login?stepup=1&returnTo=/",
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }

    if (OOB_APPROVAL_ENABLED && riskTier === "High") {
      const verification = await verifyApprovedOperation(userSub, approvalTicket, "high_risk_transfer");
      const approvedPayload = verification?.approval?.payload || {};
      const approvalMatchesTransfer =
        Number(approvedPayload.amount) === Number(parsedTransfer.amount) &&
        String(approvedPayload.toAccount || "").toLowerCase() === String(parsedTransfer.toAccount || "").toLowerCase();
      if (!verification.ok || !approvalMatchesTransfer) {
        const approval = await createOperationApproval(userSub, {
          approvalType: "high_risk_transfer",
          reason: "Out-of-band approval required for high-risk transfer.",
          payload: {
            amount: parsedTransfer.amount,
            toAccount: parsedTransfer.toAccount,
            fromAccount: parsedTransfer.fromAccount || null
          },
          ttlSeconds: OOB_APPROVAL_TTL_SECONDS
        });
        await createTransferRecord(userSub, {
          status: "blocked",
          amount: parsedTransfer.amount,
          toAccount: parsedTransfer.toAccount,
          riskStatus,
          requiresStepUp: true,
          stepUpVerified,
          details: { reason: "oob_approval_required", approvalId: approval?.id || null }
        });
        return buildResult({
          decisionFlow: [
            ...baseDecisionFlow,
            `Validated amount: ${parsedTransfer.amount}.`,
            "High-risk transfer requires out-of-band approval."
          ],
          output:
            "Approval required: please approve this high-risk transfer request, then resend the same command.",
          transfer: null,
          riskStatus,
          riskTier,
          requiresReauth: false,
          requiresApproval: true,
          approvalTicket: approval?.id || null,
          approvalPrompt: "Approve in User Settings > Pending Approvals or via /delegation/approvals/:id/approve.",
          source: "ollama",
          model: ollamaModel,
          baseUrl: ollamaBaseUrl
        });
      }
    }

    const rawTransfer = await executeSecureTransfer(parsedTransfer);
    const transfer = JSON.parse(rawTransfer);

    const balanceUpdate = await applyTransferAndUpdateBalances(userSub, {
      amount: transfer.amount ?? parsedTransfer.amount,
      toAccount: transfer.toAccount || parsedTransfer.toAccount,
      fromAccount: transfer.fromAccount || parsedTransfer.fromAccount || null,
      transactionId: transfer.transactionId || null,
      riskStatus,
      requiresStepUp: riskTier !== "Low",
      stepUpVerified,
      operationSource: "prompt",
      delegatedBy: userSub || null,
      delegationScope: Array.isArray(delegation?.delegatedOperations) ? delegation.delegatedOperations : [],
      authContext: "user-session"
    });

    if (!balanceUpdate.ok) {
      await createTransferRecord(userSub, {
        transactionId: transfer.transactionId || null,
        status: "failed",
        amount: transfer.amount ?? parsedTransfer.amount,
        toAccount: transfer.toAccount || parsedTransfer.toAccount,
        riskStatus,
        requiresStepUp: riskTier !== "Low",
        stepUpVerified,
        details: {
          error: balanceUpdate.message,
          code: balanceUpdate.code
        }
      });
      const output = await synthesizeResponse(message, {
        status: "failed",
        reason: balanceUpdate.message,
        code: balanceUpdate.code
      });
      return buildResult({
        decisionFlow: [
          ...baseDecisionFlow,
          `Validated amount: ${parsedTransfer.amount}.`,
          `Attempted transfer update failed: ${balanceUpdate.code}.`
        ],
        output,
        transfer: null,
        riskStatus,
        riskTier,
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }

    await createTransferRecord(userSub, {
      transactionId: transfer.transactionId || null,
      status: transfer.status || "unknown",
      amount: transfer.amount ?? parsedTransfer.amount,
      toAccount: transfer.toAccount || parsedTransfer.toAccount,
      riskStatus,
      requiresStepUp: riskTier !== "Low",
      stepUpVerified,
      details: transfer
    });
    const updatedHistory = await getTransactionHistory(userSub, 8);

    const output = await synthesizeResponse(message, {
      status: transfer.status,
      transfer,
      riskStatus,
      balances: balanceUpdate.balances
    });
    return buildResult(
      {
      decisionFlow: [
        ...baseDecisionFlow,
        `Validated amount: ${parsedTransfer.amount}.`,
        "Transfer executed successfully.",
        "Balances and transaction history updated."
      ],
      output,
      transfer: transfer.status === "completed" ? transfer : null,
      balances: balanceUpdate.balances,
      transactionHistory: updatedHistory,
      riskStatus,
      riskTier,
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
      },
      transfer.status === "completed"
    );
  }

  if (intentPayload.intent === "view_identity") {
    const identityFacts = buildIdentitySummary(userInfo);
    const output = await synthesizeResponse(message, {
      status: identityFacts.available ? "ok" : "missing_auth",
      reason: identityFacts.available
        ? null
        : "No valid authenticated token was provided on this request, so identity cannot be confirmed.",
      identity: identityFacts,
      sessionValidUntil: localExpiryFromEpoch(identityFacts.exp, { clientTimeZone, clientLocale })
    });
    return buildResult({
      decisionFlow: [...baseDecisionFlow, "Read identity claims from verified token context."],
      output,
      transfer: null,
      riskStatus: "Normal",
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
    }, true);
  }

  if (intentPayload.intent === "view_last_transfer") {
    const output = await synthesizeResponse(message, {
      status: lastTransfer ? "ok" : "not_found",
      lastTransfer
    });
    return buildResult({
      decisionFlow: [...baseDecisionFlow, "Fetched most recent completed transfer from persisted history."],
      output,
      transfer: null,
      riskStatus: lastTransfer && lastTransfer.amount > POLICY.highRiskTransferThreshold ? "High" : "Normal",
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
    }, true);
  }

  if (intentPayload.intent === "view_transaction_history") {
    const history = await getTransactionHistory(userSub, 10);
    const output = await synthesizeResponse(message, {
      status: history.length ? "ok" : "not_found",
      transactionHistory: history
    });
    return buildResult({
      decisionFlow: [...baseDecisionFlow, `Retrieved ${history.length} transaction record(s) from persisted history.`],
      output,
      transfer: null,
      transactionHistory: history,
      riskStatus: "Normal",
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
    }, true);
  }

  if (intentPayload.intent === "manage_automations") {
    if (!userSub) {
      const output = await synthesizeResponse(message, {
        status: "blocked",
        reason: "Authentication is required to manage automation rules."
      });
      return buildResult({
        decisionFlow: [...baseDecisionFlow, "Blocked because user is not authenticated."],
        output,
        transfer: null,
        riskStatus: "Normal",
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }
    const rules = await listAutomationRules(userSub);
    const pending = await getPendingAutomationDraft(draftKeys);
    const parsed = await parseAutomationRequestWithAi(message, {
      intentArgs: intentPayload.args,
      pendingDraft: pending?.draft || null,
      rules
    });
    const explicitActionFromMessage = fallbackAutomationActionFromMessage(message);
    let requestedAction = String(parsed?.action || "").trim().toLowerCase() || explicitActionFromMessage;
    if (
      pending &&
      pending.action === "create_rule" &&
      pending.stage !== "confirm_create" &&
      !isAffirmativeResponse(message) &&
      !isNegativeResponse(message) &&
      (explicitActionFromMessage === "unknown" || explicitActionFromMessage === "create_rule")
    ) {
      requestedAction = "continue_draft";
    }
    if (requestedAction === "cancel") {
      await clearPendingAutomationDraft(draftKeys);
      return buildResult({
        decisionFlow: [...baseDecisionFlow, "Cancelled pending automation draft."],
        output: "The operation has been cancelled.",
        transfer: null,
        riskStatus: "Normal",
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }

    if (requestedAction === "list_rules") {
      await clearPendingAutomationDraft(draftKeys);
      const output = await synthesizeResponse(message, {
        status: rules.length ? "ok" : "not_found",
        rules: rules.map((rule) => formatRuleForResponse(rule, { clientTimeZone, clientLocale }))
      });
      return buildResult({
        decisionFlow: [...baseDecisionFlow, `Listed ${rules.length} automation rule(s).`],
        output,
        transfer: null,
        riskStatus: "Normal",
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      }, true);
    }

    if (requestedAction === "run_rule") {
      await clearPendingAutomationDraft(draftKeys);
      const targetRule =
        findRuleByName(rules, parsed?.targetRuleName) ||
        rules.find((rule) => rule.enabled) ||
        rules[0] ||
        null;
      if (!targetRule) {
        const output = await synthesizeResponse(message, {
          status: "not_found",
          reason: "No automation rules found. Create one first."
        });
        return buildResult({
          decisionFlow: [...baseDecisionFlow, "No saved automation rules available to run."],
          output,
          transfer: null,
          riskStatus: "Normal",
          requiresReauth: false,
          source: "ollama",
          model: ollamaModel,
          baseUrl: ollamaBaseUrl
        });
      }

      const execution = await runAutomationRuleNow(userSub, targetRule.id, {
        highRiskThreshold: POLICY.highRiskTransferThreshold
      });
      const output = await synthesizeResponse(message, {
        status: execution.status,
        execution,
        rule: formatRuleForResponse(targetRule, { clientTimeZone, clientLocale })
      });
      return buildResult(
        {
          decisionFlow: [
            ...baseDecisionFlow,
            `Selected automation rule: ${targetRule.name}.`,
            `Run-now execution result: ${execution.status}.`
          ],
          output,
          transfer: null,
          riskStatus: execution?.operation?.riskStatus || "Normal",
          requiresReauth: false,
          source: "ollama",
          model: ollamaModel,
          baseUrl: ollamaBaseUrl
        },
        execution.status === "completed"
      );
    }

    const draftAction =
      requestedAction === "update_rule" || requestedAction === "create_rule"
        ? requestedAction
        : pending?.action || "create_rule";
    const heuristicDraft = extractAutomationFieldsFromText(message);
    const explicitFields = {
      transferAmount:
        Number.isFinite(Number(heuristicDraft.transferAmount)) ||
        intentPayload.args?.transferAmount != null ||
        (pending?.draft && Number.isFinite(Number(pending.draft.transferAmount))),
      minAvailableBalance:
        Number.isFinite(Number(heuristicDraft.minAvailableBalance)) ||
        intentPayload.args?.minAvailableBalance != null ||
        (pending?.draft && Number.isFinite(Number(pending.draft.minAvailableBalance))),
      sourceAccount: heuristicDraft.sourceAccount != null || intentPayload.args?.sourceAccount != null,
      destinationAccount: heuristicDraft.destinationAccount != null || intentPayload.args?.destinationAccount != null,
      mode: heuristicDraft.mode != null || intentPayload.args?.mode != null,
      scheduleType: heuristicDraft.scheduleType != null || intentPayload.args?.scheduleType != null
    };
    const mergedDraft = mergeAutomationDraft(
      pending?.draft || {},
      { ...(parsed?.draft || {}), ...heuristicDraft },
      intentPayload.args || {},
      explicitFields
    );
    let mergedMissing = getAutomationDraftMissing(mergedDraft);
    if (pending && mergedMissing.length > 0) {
      const shorthandDraft = extractShorthandAutomationInput(message, mergedDraft, mergedMissing);
      const shorthandExplicit = {
        transferAmount: shorthandDraft.transferAmount != null,
        minAvailableBalance: shorthandDraft.minAvailableBalance != null,
        sourceAccount: shorthandDraft.sourceAccount != null,
        destinationAccount: shorthandDraft.destinationAccount != null,
        mode: shorthandDraft.mode != null,
        scheduleType: shorthandDraft.scheduleType != null
      };
      const remappedDraft = mergeAutomationDraft(
        mergedDraft,
        shorthandDraft,
        {},
        shorthandExplicit
      );
      mergedMissing = getAutomationDraftMissing(remappedDraft);
      Object.assign(mergedDraft, remappedDraft);
    }

    if (mergedMissing.length > 0) {
      const followUpQuestion = formatMissingAutomationQuestion(mergedMissing);
      await setPendingAutomationDraft(draftKeys, {
        action: draftAction,
        targetRuleName: parsed?.targetRuleName || pending?.targetRuleName || null,
        draft: mergedDraft
      });
      const output = followUpQuestion;
      return buildResult({
        decisionFlow: [...baseDecisionFlow, `Automation draft pending. Missing fields: ${mergedMissing.join(", ")}.`],
        output,
        transfer: null,
        riskStatus: "Normal",
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }

    if (draftAction === "update_rule") {
      const targetRule =
        findRuleByName(rules, parsed?.targetRuleName) ||
        findRuleByName(rules, pending?.targetRuleName) ||
        findRuleByName(rules, mergedDraft.name);
      if (!targetRule) {
        await setPendingAutomationDraft(draftKeys, {
          action: "update_rule",
          targetRuleName: parsed?.targetRuleName || pending?.targetRuleName || null,
          draft: mergedDraft
        });
        const output = await synthesizeResponse(message, {
          status: "needs_more_info",
          question: "I couldn't find the rule to update. Tell me the exact rule name to edit.",
          rules
        });
        return buildResult({
          decisionFlow: [...baseDecisionFlow, "Update requested but target rule was not found by name."],
          output,
          transfer: null,
          riskStatus: "Normal",
          requiresReauth: false,
          source: "ollama",
          model: ollamaModel,
          baseUrl: ollamaBaseUrl
        });
      }

      const updatedRule = await updateAutomationRule(userSub, targetRule.id, {
        name: mergedDraft.name || targetRule.name,
        transferAmount: mergedDraft.transferAmount,
        minAvailableBalance: mergedDraft.minAvailableBalance,
        sourceAccount: mergedDraft.sourceAccount,
        destinationAccount: mergedDraft.destinationAccount,
        mode: mergedDraft.mode,
        scheduleType: mergedDraft.scheduleType,
        scheduleConfig: mergedDraft.scheduleConfig,
        adaptiveConfig: mergedDraft.adaptiveConfig,
        enabled: true
      });
      await clearPendingAutomationDraft(draftKeys);
      const output = await synthesizeResponse(message, {
        status: "updated",
        rule: formatRuleForResponse(updatedRule, { clientTimeZone, clientLocale })
      });
      return buildResult(
        {
          decisionFlow: [
            ...baseDecisionFlow,
            `Updated automation rule '${targetRule.name}'.`,
            "Applied latest prompt-provided configuration."
          ],
          output,
          transfer: null,
          riskStatus: "Normal",
          requiresReauth: false,
          source: "ollama",
          model: ollamaModel,
          baseUrl: ollamaBaseUrl
        },
        true
      );
    }

    if (draftAction === "create_rule") {
      if (pending?.stage === "confirm_create") {
        if (isAffirmativeResponse(message)) {
          const finalizedDraft = pending?.draft || mergedDraft;
          const createdRule = await createAutomationRule(userSub, {
            name: finalizedDraft.name || `Rule ${new Date().toLocaleDateString()}`,
            transferAmount: finalizedDraft.transferAmount,
            minAvailableBalance: finalizedDraft.minAvailableBalance,
            sourceAccount: finalizedDraft.sourceAccount,
            destinationAccount: finalizedDraft.destinationAccount,
            mode: finalizedDraft.mode,
            scheduleType: finalizedDraft.scheduleType,
            scheduleConfig: finalizedDraft.scheduleConfig,
            adaptiveConfig: finalizedDraft.adaptiveConfig,
            enabled: true
          });
          await clearPendingAutomationDraft(draftKeys);
          const output = await synthesizeResponse(message, {
            status: "created",
            rule: formatRuleForResponse(createdRule, { clientTimeZone, clientLocale })
          });
          return buildResult(
            {
              decisionFlow: [
                ...baseDecisionFlow,
                "User confirmed prompt-based automation creation.",
                `Created rule: ${createdRule.name}.`
              ],
              output,
              transfer: null,
              riskStatus: "Normal",
              requiresReauth: false,
              source: "ollama",
              model: ollamaModel,
              baseUrl: ollamaBaseUrl
            },
            true
          );
        }

        if (isNegativeResponse(message)) {
          await clearPendingAutomationDraft(draftKeys);
          return buildResult({
            decisionFlow: [...baseDecisionFlow, "User cancelled prompt-based rule creation."],
            output: "Rule creation cancelled.",
            transfer: null,
            riskStatus: "Normal",
            requiresReauth: false,
            source: "ollama",
            model: ollamaModel,
            baseUrl: ollamaBaseUrl
          });
        }
      }

      await setPendingAutomationDraft(draftKeys, {
        action: "create_rule",
        stage: "confirm_create",
        targetRuleName: mergedDraft.name || null,
        draft: mergedDraft
      });
      return buildResult({
        decisionFlow: [...baseDecisionFlow, "Prepared rule creation preview and requested explicit confirmation."],
        output: buildCreationPreview(mergedDraft),
        transfer: null,
        riskStatus: "Normal",
        requiresReauth: false,
        source: "ollama",
        model: ollamaModel,
        baseUrl: ollamaBaseUrl
      });
    }
  }

  if (intentPayload.intent === "explain_policy") {
    const output = await synthesizeResponse(message, {
      policy: {
        riskLevels: POLICY.riskLevels,
        mediumRiskThreshold: POLICY.mediumRiskTransferThreshold,
        highRiskThreshold: POLICY.highRiskTransferThreshold,
        stepUpRequired: true,
        outOfBandApprovalRequiredForHighRisk: OOB_APPROVAL_ENABLED
      }
    });
    return buildResult({
      decisionFlow: [...baseDecisionFlow, "Returned configured transfer policy and risk levels."],
      output,
      transfer: null,
      riskStatus: "Normal",
      requiresReauth: false,
      source: "ollama",
      model: ollamaModel,
      baseUrl: ollamaBaseUrl
    });
  }

  const output = await synthesizeResponse(message, {
    status: "general",
    capabilities: CAPABILITIES.map((capability) => capability.intent)
  });
  return buildResult({
    decisionFlow: [...baseDecisionFlow, "Answered as a general informational request."],
    output,
    transfer: null,
    riskStatus: "Normal",
    requiresReauth: false,
    source: "ollama",
    model: ollamaModel,
    baseUrl: ollamaBaseUrl
  });
}
