import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Ollama } from "@langchain/ollama";
import { dbQuery, getDbPool } from "./db.js";
import {
  applyTransferAndUpdateBalances,
  createTransferRecord,
  getAccountState,
  getDelegation,
  upsertUserByClaims
} from "./delegation.js";
import { getMachineAccessToken } from "./m2m.js";

const DEFAULT_INTERVAL_MINUTES = 1440;
const MAX_INTERVAL_MINUTES = 60 * 24 * 30;
const MIN_INTERVAL_MINUTES = Math.max(1, Number(process.env.AUTOMATION_MIN_INTERVAL_MINUTES) || 5);
const DEFAULT_HIGH_RISK_THRESHOLD = 100;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "llama3.1:8b";
const AUTOMATION_SOURCE = "ollama";
const AUTOMATION_MODEL = ollamaModel;
const automationModel = new Ollama({
  baseUrl: ollamaBaseUrl,
  model: ollamaModel,
  temperature: 0
});

let automationSchemaReady = null;
let schedulerStarted = false;
let schedulerRunning = false;

function normalizeSub(sub) {
  return String(sub || "").trim();
}

function normalizeAmount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : NaN;
}

function normalizeAccountName(raw, fallback) {
  const value = String(raw || "").toLowerCase();
  if (value.includes("saving")) {
    return "savings";
  }
  if (value.includes("available") || value.includes("checking") || value.includes("balance")) {
    return "available";
  }
  return fallback;
}

function clampIntervalMinutes(minutes) {
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Number(minutes) || DEFAULT_INTERVAL_MINUTES));
}

function intervalToMs(minutes) {
  return clampIntervalMinutes(minutes) * 60 * 1000;
}

function safeJsonObject(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeAdaptiveConfig(raw) {
  const value = safeJsonObject(raw);
  const rawRules = Array.isArray(value.rules) ? value.rules : [];
  const rules = rawRules
    .map((item) => ({
      whenBalanceBelow: normalizeAmount(item?.whenBalanceBelow),
      transferAmount: normalizeAmount(item?.transferAmount)
    }))
    .filter(
      (rule) =>
        Number.isFinite(rule.whenBalanceBelow) &&
        rule.whenBalanceBelow >= 0 &&
        Number.isFinite(rule.transferAmount) &&
        rule.transferAmount > 0
    )
    .sort((a, b) => a.whenBalanceBelow - b.whenBalanceBelow);
  return { rules };
}

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

function parseAutomationDecision(rawText) {
  const jsonText = extractJsonObject(rawText);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    const action = String(parsed?.action || "").toLowerCase();
    if (action !== "execute" && action !== "skip") {
      return null;
    }

    const reason = String(parsed?.reason || "").trim() || "No reason provided.";
    const riskStatusRaw = String(parsed?.riskStatus || "Normal").trim().toLowerCase();
    const riskStatus = riskStatusRaw === "high" ? "High" : "Normal";
    const decisionFlow = Array.isArray(parsed?.decisionFlow)
      ? parsed.decisionFlow.map((step) => String(step || "").trim()).filter(Boolean).slice(0, 8)
      : [];

    return { action, reason, riskStatus, decisionFlow };
  } catch {
    return null;
  }
}

async function decideAutomationWithAi({
  row,
  currentState,
  scheduled,
  highRiskThreshold,
  transferAmount
}) {
  const amount = Number.isFinite(Number(transferAmount)) ? Number(transferAmount) : Number(row.transfer_amount);
  const threshold = Number(row.min_available_balance);
  const prompt = `You are a banking automation policy engine.
Return JSON only with this exact schema:
{"action":"execute|skip","reason":"short reason","riskStatus":"Normal|High","decisionFlow":["step 1","step 2"]}

Rules:
1) If availableBalance < minAvailableBalance, action must be "skip".
2) If this is a scheduled run and transferAmount > highRiskThreshold, action must be "skip".
3) RiskStatus is "High" if transferAmount > highRiskThreshold, else "Normal".
4) decisionFlow must explain why you chose execute or skip.
5) Never include markdown, only valid JSON.

Context:
${JSON.stringify(
    {
      ruleId: row.id,
      ruleName: row.name,
      scheduledRun: Boolean(scheduled),
      availableBalance: Number(currentState.availableBalance),
      savingsBalance: Number(currentState.savingsBalance),
      sourceAccount: row.source_account,
      destinationAccount: row.destination_account,
      transferAmount: amount,
      minAvailableBalance: threshold,
      highRiskThreshold: Number(highRiskThreshold)
    },
    null,
    2
  )}`;

  const raw = await automationModel.invoke(prompt);
  const parsed = parseAutomationDecision(raw);
  if (parsed) {
    return parsed;
  }

  throw new Error("AUTOMATION_AI_DECISION_INVALID");
}

function parseDateList(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => new Date(item))
    .filter((date) => Number.isFinite(date.getTime()))
    .map((date) => date.toISOString())
    .sort();
}

function mapRuleRow(row) {
  return {
    id: row.id,
    name: row.name,
    sourceAccount: row.source_account,
    destinationAccount: row.destination_account,
    minAvailableBalance: Number(row.min_available_balance),
    transferAmount: Number(row.transfer_amount),
    mode: row.mode,
    intervalMinutes: Number(row.interval_minutes),
    scheduleType: row.schedule_type || "custom_interval",
    scheduleConfig: safeJsonObject(row.schedule_config),
    adaptiveConfig: normalizeAdaptiveConfig(row.adaptive_config),
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function computeScheduleProfile(input = {}) {
  const scheduleTypeRaw = String(input.scheduleType || "custom_interval").toLowerCase();
  const scheduleConfigRaw = safeJsonObject(input.scheduleConfig);

  if (scheduleTypeRaw === "hourly") {
    return { scheduleType: "hourly", scheduleConfig: {}, intervalMinutes: 60 };
  }

  if (scheduleTypeRaw === "daily") {
    return { scheduleType: "daily", scheduleConfig: {}, intervalMinutes: 1440 };
  }

  if (scheduleTypeRaw === "weekly_n_times") {
    const times = Math.max(1, Math.min(7, Math.floor(Number(scheduleConfigRaw.timesPerWeek) || 1)));
    const interval = Math.floor((7 * 24 * 60) / times);
    return {
      scheduleType: "weekly_n_times",
      scheduleConfig: { timesPerWeek: times },
      intervalMinutes: clampIntervalMinutes(interval)
    };
  }

  if (scheduleTypeRaw === "specific_dates") {
    const dates = parseDateList(scheduleConfigRaw.dates);
    if (!dates.length) {
      throw new Error("SPECIFIC_DATES_REQUIRED");
    }
    return {
      scheduleType: "specific_dates",
      scheduleConfig: { dates },
      intervalMinutes: DEFAULT_INTERVAL_MINUTES
    };
  }

  const customInterval = clampIntervalMinutes(
    Number(scheduleConfigRaw.intervalMinutes) || Number(input.intervalMinutes) || DEFAULT_INTERVAL_MINUTES
  );
  return {
    scheduleType: "custom_interval",
    scheduleConfig: { intervalMinutes: customInterval },
    intervalMinutes: customInterval
  };
}

function computeNextRunAt(now, mode, scheduleType, scheduleConfig, intervalMinutes) {
  const baseTime = Number.isFinite(new Date(now).getTime()) ? new Date(now) : new Date();
  if (mode !== "scheduled") {
    return null;
  }

  if (scheduleType === "specific_dates") {
    const dates = parseDateList(scheduleConfig?.dates);
    const next = dates.find((iso) => new Date(iso).getTime() > baseTime.getTime());
    return next || null;
  }

  if (scheduleType === "hourly") {
    return new Date(baseTime.getTime() + 60 * 60 * 1000).toISOString();
  }
  if (scheduleType === "daily") {
    return new Date(baseTime.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  if (scheduleType === "weekly_n_times") {
    const timesPerWeek = Math.max(1, Math.min(7, Math.floor(Number(scheduleConfig?.timesPerWeek) || 1)));
    const minutes = Math.floor((7 * 24 * 60) / timesPerWeek);
    return new Date(baseTime.getTime() + intervalToMs(minutes)).toISOString();
  }

  return new Date(baseTime.getTime() + intervalToMs(intervalMinutes)).toISOString();
}

async function ensureAutomationSchema() {
  if (!getDbPool()) {
    return;
  }

  if (!automationSchemaReady) {
    automationSchemaReady = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS transfer_automation_rules (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          source_account TEXT NOT NULL DEFAULT 'available',
          destination_account TEXT NOT NULL DEFAULT 'savings',
          min_available_balance NUMERIC(14,2) NOT NULL,
          transfer_amount NUMERIC(14,2) NOT NULL,
          mode TEXT NOT NULL DEFAULT 'scheduled',
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          schedule_type TEXT NOT NULL DEFAULT 'custom_interval',
          schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          adaptive_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          last_run_at TIMESTAMPTZ,
          next_run_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await dbQuery(
        `ALTER TABLE transfer_automation_rules ADD COLUMN IF NOT EXISTS schedule_type TEXT NOT NULL DEFAULT 'custom_interval'`
      );
      await dbQuery(
        `ALTER TABLE transfer_automation_rules ADD COLUMN IF NOT EXISTS schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb`
      );
      await dbQuery(
        `ALTER TABLE transfer_automation_rules ADD COLUMN IF NOT EXISTS adaptive_config JSONB NOT NULL DEFAULT '{}'::jsonb`
      );

      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_transfer_automation_rules_user_id
        ON transfer_automation_rules(user_id)
      `);

      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_transfer_automation_rules_next_run
        ON transfer_automation_rules(enabled, mode, next_run_at)
      `);
    })().catch((error) => {
      automationSchemaReady = null;
      throw error;
    });
  }

  await automationSchemaReady;
}

function validateRuleInput(input = {}, existing = null) {
  const transferAmount =
    input.transferAmount == null && existing
      ? Number(existing.transfer_amount)
      : normalizeAmount(input.transferAmount);
  const minAvailableBalance =
    input.minAvailableBalance == null && existing
      ? Number(existing.min_available_balance)
      : normalizeAmount(input.minAvailableBalance);
  const sourceAccount = normalizeAccountName(input.sourceAccount ?? existing?.source_account, "available");
  const destinationAccount = normalizeAccountName(input.destinationAccount ?? existing?.destination_account, "savings");
  const mode =
    input.mode == null && existing
      ? String(existing.mode)
      : String(input.mode || "scheduled").toLowerCase() === "on_demand"
        ? "on_demand"
        : "scheduled";
  const enabled = input.enabled == null ? (existing ? Boolean(existing.enabled) : true) : Boolean(input.enabled);
  const name = String(input.name || existing?.name || "Auto Savings Rule").trim() || "Auto Savings Rule";

  if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
    throw new Error("TRANSFER_AMOUNT_REQUIRED");
  }
  if (!Number.isFinite(minAvailableBalance) || minAvailableBalance < 0) {
    throw new Error("MIN_BALANCE_REQUIRED");
  }
  if (sourceAccount === destinationAccount) {
    throw new Error("INVALID_ACCOUNTS");
  }

  const scheduleProfile = computeScheduleProfile({
    scheduleType: input.scheduleType ?? existing?.schedule_type,
    scheduleConfig: input.scheduleConfig ?? safeJsonObject(existing?.schedule_config),
    intervalMinutes: input.intervalMinutes ?? existing?.interval_minutes
  });
  const adaptiveConfig = normalizeAdaptiveConfig(input.adaptiveConfig ?? existing?.adaptive_config);

  return {
    transferAmount,
    minAvailableBalance,
    sourceAccount,
    destinationAccount,
    mode,
    enabled,
    name,
    intervalMinutes: scheduleProfile.intervalMinutes,
    scheduleType: scheduleProfile.scheduleType,
    scheduleConfig: scheduleProfile.scheduleConfig,
    adaptiveConfig
  };
}

async function resolveUser(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return null;
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  return user?.id ? user : null;
}

export async function createAutomationRule(sub, input = {}) {
  const user = await resolveUser(sub);
  if (!user?.id) {
    throw new Error("AUTH_REQUIRED");
  }

  await ensureAutomationSchema();
  const normalized = validateRuleInput(input);
  const nextRunAt =
    normalized.enabled && normalized.mode === "scheduled"
      ? computeNextRunAt(new Date(), normalized.mode, normalized.scheduleType, normalized.scheduleConfig, normalized.intervalMinutes)
      : null;

  const result = await dbQuery(
    `
      INSERT INTO transfer_automation_rules (
        id, user_id, name, source_account, destination_account,
        min_available_balance, transfer_amount, mode, interval_minutes,
        schedule_type, schedule_config, adaptive_config, enabled, next_run_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
      RETURNING *
    `,
    [
      crypto.randomUUID(),
      user.id,
      normalized.name,
      normalized.sourceAccount,
      normalized.destinationAccount,
      normalized.minAvailableBalance,
      normalized.transferAmount,
      normalized.mode,
      normalized.intervalMinutes,
      normalized.scheduleType,
      JSON.stringify(normalized.scheduleConfig || {}),
      JSON.stringify(normalized.adaptiveConfig || {}),
      normalized.enabled,
      nextRunAt
    ]
  );

  return mapRuleRow(result.rows[0]);
}

export async function listAutomationRules(sub) {
  const user = await resolveUser(sub);
  if (!user?.id) {
    return [];
  }

  await ensureAutomationSchema();

  const result = await dbQuery(
    `
      SELECT *
      FROM transfer_automation_rules
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
    [user.id]
  );

  return result.rows.map(mapRuleRow);
}

async function getAutomationRuleByIdForUser(sub, ruleId) {
  const user = await resolveUser(sub);
  if (!user?.id) {
    return null;
  }

  await ensureAutomationSchema();

  const result = await dbQuery(
    `
      SELECT r.*, u.sub
      FROM transfer_automation_rules r
      JOIN users u ON u.id = r.user_id
      WHERE r.user_id = $1 AND r.id = $2
      LIMIT 1
    `,
    [user.id, String(ruleId)]
  );
  return result.rows[0] || null;
}

export async function updateAutomationRule(sub, ruleId, input = {}) {
  const row = await getAutomationRuleByIdForUser(sub, ruleId);
  if (!row) {
    return null;
  }

  const normalized = validateRuleInput(input, row);
  const nextRunAt =
    normalized.enabled && normalized.mode === "scheduled"
      ? computeNextRunAt(new Date(), normalized.mode, normalized.scheduleType, normalized.scheduleConfig, normalized.intervalMinutes)
      : null;

  const result = await dbQuery(
    `
      UPDATE transfer_automation_rules
      SET name = $2,
          source_account = $3,
          destination_account = $4,
          min_available_balance = $5,
          transfer_amount = $6,
          mode = $7,
          interval_minutes = $8,
          schedule_type = $9,
          schedule_config = $10::jsonb,
          adaptive_config = $11::jsonb,
          enabled = $12,
          next_run_at = $13,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      String(ruleId),
      normalized.name,
      normalized.sourceAccount,
      normalized.destinationAccount,
      normalized.minAvailableBalance,
      normalized.transferAmount,
      normalized.mode,
      normalized.intervalMinutes,
      normalized.scheduleType,
      JSON.stringify(normalized.scheduleConfig || {}),
      JSON.stringify(normalized.adaptiveConfig || {}),
      normalized.enabled,
      nextRunAt
    ]
  );

  return result.rows[0] ? mapRuleRow(result.rows[0]) : null;
}

export async function deleteAutomationRule(sub, ruleId) {
  const row = await getAutomationRuleByIdForUser(sub, ruleId);
  if (!row) {
    return false;
  }

  await dbQuery(`DELETE FROM transfer_automation_rules WHERE id = $1`, [String(ruleId)]);
  return true;
}

async function markRuleRun(row) {
  const nextRunAt = computeNextRunAt(
    new Date(),
    row.mode,
    row.schedule_type || "custom_interval",
    safeJsonObject(row.schedule_config),
    Number(row.interval_minutes)
  );

  if (!nextRunAt && row.mode === "scheduled") {
    await dbQuery(
      `
        UPDATE transfer_automation_rules
        SET last_run_at = NOW(),
            next_run_at = NULL,
            enabled = FALSE,
            updated_at = NOW()
        WHERE id = $1
      `,
      [row.id]
    );
    return;
  }

  await dbQuery(
    `
      UPDATE transfer_automation_rules
      SET last_run_at = NOW(),
          next_run_at = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [row.id, nextRunAt]
  );
}

async function executeRuleRow(row, { scheduled = false, highRiskThreshold = DEFAULT_HIGH_RISK_THRESHOLD } = {}) {
  const baseDecisionFlow = [
    `Loaded rule '${row.name}' (${row.id}).`,
    `Mode: ${row.mode}${scheduled ? " (scheduled run)" : " (manual run)"}.`
  ];
  const currentState = await getAccountState(row.sub);
  baseDecisionFlow.push(
    `Current available balance: ${currentState.availableBalance.toFixed(2)}. Rule threshold: ${Number(row.min_available_balance).toFixed(2)}.`
  );
  baseDecisionFlow.push("Asked AI engine to evaluate whether this rule should execute.");

  const amount = Number(row.transfer_amount);
  const adaptiveConfig = normalizeAdaptiveConfig(row.adaptive_config);
  let effectiveAmount = amount;
  if (Array.isArray(adaptiveConfig.rules) && adaptiveConfig.rules.length) {
    const available = Number(currentState.availableBalance);
    const matchedRule = adaptiveConfig.rules.find((rule) => available <= rule.whenBalanceBelow);
    if (matchedRule && matchedRule.transferAmount > 0) {
      effectiveAmount = Math.min(amount, matchedRule.transferAmount);
      if (effectiveAmount < amount) {
        baseDecisionFlow.push(
          `Adaptive transfer rule applied: available balance ${available.toFixed(2)} <= ${matchedRule.whenBalanceBelow.toFixed(2)}, amount reduced to ${effectiveAmount.toFixed(2)}.`
        );
      }
    }
  }
  let aiDecision;
  try {
    aiDecision = await decideAutomationWithAi({
      row,
      currentState,
      scheduled,
      highRiskThreshold,
      transferAmount: effectiveAmount
    });
  } catch (error) {
    const reason =
      error?.message === "fetch failed"
        ? `AI decision failed: cannot reach Ollama at ${ollamaBaseUrl}.`
        : error?.message === "AUTOMATION_AI_DECISION_INVALID"
          ? "AI decision failed: invalid policy decision format."
          : `AI decision failed: ${String(error?.message || "unknown error")}`;
    if (scheduled) {
      await markRuleRun(row);
    }
    return {
      status: "failed",
      source: AUTOMATION_SOURCE,
      model: AUTOMATION_MODEL,
      reason,
      code: "AUTOMATION_AI_UNAVAILABLE",
      operation: {
        amount,
        fromAccount: row.source_account,
        toAccount: row.destination_account,
        riskStatus: amount > highRiskThreshold ? "High" : "Normal"
      },
      balances: currentState,
      decisionSource: "ollama-automation-policy",
      decisionFlow: [...baseDecisionFlow, "AI decision failed before execution."]
    };
  }

  const aiDecisionFlow = Array.isArray(aiDecision.decisionFlow) ? aiDecision.decisionFlow : [];
  const operation = {
    amount: effectiveAmount,
    baseAmount: amount,
    fromAccount: row.source_account,
    toAccount: row.destination_account,
    riskStatus: aiDecision.riskStatus || (effectiveAmount > highRiskThreshold ? "High" : "Normal")
  };

  const minAvailableBalance = Number(row.min_available_balance);
  const belowThreshold = Number(currentState.availableBalance) < minAvailableBalance;
  const scheduledHighRiskBlocked = Boolean(scheduled && effectiveAmount > highRiskThreshold);
  if ((belowThreshold || scheduledHighRiskBlocked) && aiDecision.action === "execute") {
    if (scheduled) {
      await markRuleRun(row);
    }

    const guardrailReason = belowThreshold
      ? `Guardrail blocked execution: available balance ${Number(currentState.availableBalance).toFixed(2)} is below minimum ${minAvailableBalance.toFixed(2)}.`
      : `Guardrail blocked execution: scheduled transfer amount ${effectiveAmount.toFixed(2)} exceeds high-risk threshold ${Number(highRiskThreshold).toFixed(2)}.`;

    return {
      status: "skipped",
      source: AUTOMATION_SOURCE,
      model: AUTOMATION_MODEL,
      reason: guardrailReason,
      code: "AUTOMATION_GUARDRAIL_BLOCK",
      operation,
      balances: currentState,
      decisionSource: "automation-guardrail",
      decisionFlow: [
        ...baseDecisionFlow,
        ...aiDecisionFlow,
        "AI decision requested execution.",
        "Deterministic guardrail validation failed.",
        guardrailReason
      ]
    };
  }

  if (aiDecision.action === "skip") {
    if (scheduled) {
      await markRuleRun(row);
    }
    return {
      status: "skipped",
      source: AUTOMATION_SOURCE,
      model: AUTOMATION_MODEL,
      reason: aiDecision.reason,
      operation,
      balances: currentState,
      decisionSource: "ollama-automation-policy",
      decisionFlow: [...baseDecisionFlow, ...aiDecisionFlow, "AI decision: skip execution."]
    };
  }

  const riskStatus = operation.riskStatus;
  const delegationSnapshot = await getDelegation(row.sub);
  const delegatedScope = Array.isArray(delegationSnapshot?.delegatedOperations)
    ? delegationSnapshot.delegatedOperations
    : [];
  const executionTimestamp = new Date().toISOString();
  const automationMode = scheduled ? "scheduled" : "on_demand";
  const delegatedBy = row.sub;
  let authContext = "user-delegated";
  let authClientId = null;
  let authScopes = [];
  if (scheduled) {
    try {
      const machineToken = await getMachineAccessToken();
      authContext = "m2m";
      authClientId = machineToken.clientId || null;
      authScopes = Array.isArray(machineToken.scopeList) ? machineToken.scopeList : [];
      baseDecisionFlow.push(
        `Acquired machine token (client_credentials) for scheduled execution${authScopes.length ? ` with scopes: ${authScopes.join(", ")}.` : "."}`
      );
    } catch (error) {
      await markRuleRun(row);
      const reason =
        error?.message === "M2M_CONFIG_MISSING"
          ? "Scheduled execution failed: M2M client credentials configuration is missing."
          : `Scheduled execution failed: unable to get M2M token (${String(error?.message || "unknown error")}).`;
      return {
        status: "failed",
        source: AUTOMATION_SOURCE,
        model: AUTOMATION_MODEL,
        reason,
        code: "M2M_TOKEN_REQUIRED",
        operation,
        balances: currentState,
        decisionSource: "m2m-auth-service",
        decisionFlow: [...baseDecisionFlow, reason]
      };
    }
  }
  const transferResult = await applyTransferAndUpdateBalances(row.sub, {
    amount: effectiveAmount,
    fromAccount: row.source_account,
    toAccount: row.destination_account,
    riskStatus,
    requiresStepUp: effectiveAmount > highRiskThreshold,
    stepUpVerified: !scheduled,
    transactionId: crypto.randomUUID(),
    operationSource: "automation",
    automationExecutionType: automationMode,
    automationRuleId: row.id,
    delegatedBy,
    delegationScope: delegatedScope,
    executionTimestamp,
    authContext,
    authClientId,
    authScopes
  });

  if (!transferResult.ok) {
    if (scheduled) {
      await markRuleRun(row);
    }
    return {
      status: "failed",
      source: AUTOMATION_SOURCE,
      model: AUTOMATION_MODEL,
      reason: transferResult.message,
      code: transferResult.code,
      operation,
      balances: transferResult.balances || currentState,
      decisionSource: "account-transfer-engine",
      decisionFlow: [
        ...baseDecisionFlow,
        ...aiDecisionFlow,
        "AI decision: execute transfer.",
        `Transfer failed with code ${transferResult.code}.`
      ]
    };
  }

  await createTransferRecord(row.sub, {
    status: "completed",
    amount: effectiveAmount,
    toAccount: row.destination_account,
    riskStatus,
    requiresStepUp: effectiveAmount > highRiskThreshold,
    stepUpVerified: !scheduled,
    details: {
      automated: true,
      ruleId: row.id,
      sourceAccount: row.source_account,
      destinationAccount: row.destination_account,
      mode: row.mode,
      scheduleType: row.schedule_type || "custom_interval",
      scheduled,
      delegatedBy,
      delegationScope: delegatedScope,
      executionTimestamp,
      source: "automation",
      executionMode: automationMode,
      authContext,
      authClientId,
      authScopes
    }
  });

  if (row.mode === "scheduled") {
    await markRuleRun(row);
  }

  return {
    status: "completed",
    source: AUTOMATION_SOURCE,
    model: AUTOMATION_MODEL,
    ruleId: row.id,
    decisionSource: "ollama-automation-policy",
    decisionFlow: [...baseDecisionFlow, ...aiDecisionFlow, "AI decision: execute transfer.", "Transfer executed and persisted successfully."],
    operation,
    balances: transferResult.balances
  };
}

export async function runAutomationRuleNow(sub, ruleId, options = {}) {
  const row = await getAutomationRuleByIdForUser(sub, ruleId);
  if (!row) {
    return {
      status: "not_found",
      source: AUTOMATION_SOURCE,
      model: AUTOMATION_MODEL,
      reason: "Automation rule not found.",
      decisionSource: "automation-rule-engine",
      decisionFlow: ["Rule lookup failed. No matching automation rule for this user."]
    };
  }

  return executeRuleRow(row, { scheduled: false, highRiskThreshold: options.highRiskThreshold });
}

export async function evaluateDueAutomationRules(options = {}) {
  if (!getDbPool()) {
    return { processed: 0 };
  }

  if (schedulerRunning) {
    return { processed: 0, skipped: true };
  }

  schedulerRunning = true;
  try {
    await ensureAutomationSchema();
    const result = await dbQuery(
      `
        SELECT r.*, u.sub
        FROM transfer_automation_rules r
        JOIN users u ON u.id = r.user_id
        WHERE r.enabled = TRUE
          AND r.mode = 'scheduled'
          AND r.next_run_at IS NOT NULL
          AND r.next_run_at <= NOW()
        ORDER BY r.next_run_at ASC
        LIMIT 50
      `
    );

    for (const row of result.rows) {
      try {
        await executeRuleRow(row, { scheduled: true, highRiskThreshold: options.highRiskThreshold });
      } catch {
        await markRuleRun(row);
      }
    }

    return { processed: result.rows.length };
  } finally {
    schedulerRunning = false;
  }
}

export function startAutomationScheduler() {
  if (schedulerStarted || !getDbPool()) {
    return;
  }

  schedulerStarted = true;
  const evaluatorSeconds = Math.max(30, Number(process.env.AUTOMATION_EVALUATOR_SECONDS) || 60);

  evaluateDueAutomationRules().catch((error) => {
    console.error("[automation-scheduler] initial evaluation failed:", error?.message || error);
  });

  setInterval(() => {
    evaluateDueAutomationRules().catch((error) => {
      console.error("[automation-scheduler] evaluation failed:", error?.message || error);
    });
  }, evaluatorSeconds * 1000);
}
