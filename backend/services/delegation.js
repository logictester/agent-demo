import crypto from "crypto";
import { dbQuery, getDbPool } from "./db.js";

const DEFAULT_AVAILABLE_BALANCE = 24982.14;
const DEFAULT_SAVINGS_BALANCE = 7410.0;

const ALLOWED_OPERATIONS = [
  {
    key: "transfer_funds",
    label: "Transfer funds",
    description: "Allow the agent to move money between accounts."
  },
  {
    key: "view_identity",
    label: "View identity",
    description: "Allow the agent to read and explain token-backed profile details."
  },
  {
    key: "view_last_transfer",
    label: "View last transfer",
    description: "Allow the agent to summarize your most recent transfer."
  },
  {
    key: "view_transaction_history",
    label: "View transaction history",
    description: "Allow the agent to access your persisted transaction history."
  },
  {
    key: "manage_automations",
    label: "Manage automations",
    description: "Allow the agent to create and execute automated transfer rules."
  }
];

const DELEGATION_PURPOSE_OPTIONS = [
  {
    key: "general_assistance",
    label: "General assistance",
    description: "Allow broad assistant support operations."
  },
  {
    key: "savings_optimization",
    label: "Savings optimization",
    description: "Allow actions focused on growing savings."
  },
  {
    key: "cashflow_management",
    label: "Cashflow management",
    description: "Allow automated balance and liquidity operations."
  },
  {
    key: "bill_pay_support",
    label: "Bill pay support",
    description: "Allow assistant actions for payment support scenarios."
  },
  {
    key: "security_review",
    label: "Security review",
    description: "Allow security and account activity investigation actions."
  }
];

let accountSchemaReady = null;
let interactionSchemaReady = null;
let delegationSchemaReady = null;

const DEFAULT_DELEGATION_CONSTRAINTS = {
  purpose: "general_assistance",
  purposes: ["general_assistance"],
  expiresAt: null,
  maxTransferAmount: null
};

function fallbackDelegation() {
  return {
    idvVerified: false,
    idvVerifiedAt: null,
    delegatedOperations: [],
    constraints: { ...DEFAULT_DELEGATION_CONSTRAINTS }
  };
}

function fallbackAccountState() {
  return {
    availableBalance: DEFAULT_AVAILABLE_BALANCE,
    savingsBalance: DEFAULT_SAVINGS_BALANCE
  };
}

function fallbackInteractionStats() {
  return {
    questionsAsked: 0,
    questionsAnswered: 0,
    operationsPerformed: 0
  };
}

function normalizeSub(sub) {
  return String(sub || "").trim();
}

function safeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAmount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function safeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeDelegationConstraints(input = {}) {
  const raw = safeJsonObject(input);
  const allowedPurposes = new Set(DELEGATION_PURPOSE_OPTIONS.map((item) => item.key));
  const explicitPurposes = Array.isArray(raw.purposes)
    ? raw.purposes.map((item) => String(item || "").trim()).filter((item) => allowedPurposes.has(item))
    : [];
  const legacyPurpose = String(raw.purpose || "").trim();
  const purposes = Array.from(
    new Set(
      explicitPurposes.length
        ? explicitPurposes
        : legacyPurpose && allowedPurposes.has(legacyPurpose)
          ? [legacyPurpose]
          : DEFAULT_DELEGATION_CONSTRAINTS.purposes
    )
  );
  const purpose = String(purposes[0] || DEFAULT_DELEGATION_CONSTRAINTS.purpose);
  const expiresAtRaw = String(raw.expiresAt || "").trim();
  const expiresAtDate = expiresAtRaw ? new Date(expiresAtRaw) : null;
  const expiresAt =
    expiresAtDate && Number.isFinite(expiresAtDate.getTime()) ? expiresAtDate.toISOString() : null;
  const maxTransferAmountRaw = raw.maxTransferAmount;
  const maxTransferAmountNum = Number(maxTransferAmountRaw);
  const maxTransferAmount =
    Number.isFinite(maxTransferAmountNum) && maxTransferAmountNum > 0
      ? Number(maxTransferAmountNum.toFixed(2))
      : null;

  return {
    purpose,
    purposes,
    expiresAt,
    maxTransferAmount
  };
}

function resolveInternalAccountName(rawAccount, fallback = null) {
  const value = String(rawAccount || "").toLowerCase();
  if (value.includes("saving")) {
    return "savings";
  }
  if (value.includes("available") || value.includes("balance") || value.includes("checking")) {
    return "available";
  }
  return fallback;
}

async function ensureAccountSchema() {
  if (!getDbPool()) {
    return;
  }

  if (!accountSchemaReady) {
    accountSchemaReady = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS account_balances (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          available_balance NUMERIC(14,2) NOT NULL DEFAULT 24982.14,
          savings_balance NUMERIC(14,2) NOT NULL DEFAULT 7410.00,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await dbQuery(`
        CREATE TABLE IF NOT EXISTS account_transactions (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          amount NUMERIC(14,2) NOT NULL,
          from_account TEXT,
          to_account TEXT,
          description TEXT,
          external_transaction_id TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_account_transactions_user_id_created_at
        ON account_transactions(user_id, created_at DESC)
      `);
    })().catch((error) => {
      accountSchemaReady = null;
      throw error;
    });
  }

  await accountSchemaReady;
}

async function ensureInteractionSchema() {
  if (!getDbPool()) {
    return;
  }

  if (!interactionSchemaReady) {
    interactionSchemaReady = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS agent_interactions (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          question TEXT,
          intent TEXT,
          operation_key TEXT,
          answered BOOLEAN NOT NULL DEFAULT FALSE,
          operation_performed BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_agent_interactions_user_id_created_at
        ON agent_interactions(user_id, created_at DESC)
      `);
    })().catch((error) => {
      interactionSchemaReady = null;
      throw error;
    });
  }

  await interactionSchemaReady;
}

async function ensureDelegationSchema() {
  if (!getDbPool()) {
    return;
  }

  if (!delegationSchemaReady) {
    delegationSchemaReady = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS delegations (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          idv_verified BOOLEAN NOT NULL DEFAULT FALSE,
          idv_verified_at TIMESTAMPTZ,
          delegated_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
          delegation_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await dbQuery(`
        ALTER TABLE delegations
        ADD COLUMN IF NOT EXISTS delegation_constraints JSONB NOT NULL DEFAULT '{}'::jsonb
      `);

      await dbQuery(`
        CREATE TABLE IF NOT EXISTS operation_approvals (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          approval_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          resolved_at TIMESTAMPTZ,
          resolved_by_sub TEXT
        )
      `);
      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_operation_approvals_user_status
        ON operation_approvals(user_id, status, created_at DESC)
      `);
      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_operation_approvals_expires_at
        ON operation_approvals(expires_at)
      `);
    })().catch((error) => {
      delegationSchemaReady = null;
      throw error;
    });
  }

  await delegationSchemaReady;
}

async function ensureUserAccountState(userId) {
  await ensureAccountSchema();
  await dbQuery(
    `
      INSERT INTO account_balances (user_id, available_balance, savings_balance)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId, DEFAULT_AVAILABLE_BALANCE, DEFAULT_SAVINGS_BALANCE]
  );
}

function mapAccountRow(row) {
  return {
    availableBalance: normalizeAmount(row.available_balance),
    savingsBalance: normalizeAmount(row.savings_balance)
  };
}

function mapHistoryRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    amount: normalizeAmount(row.amount),
    fromAccount: row.from_account || null,
    toAccount: row.to_account || null,
    description: row.description || null,
    externalTransactionId: row.external_transaction_id || null,
    timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
    metadata: row.metadata || {}
  };
}

export function getDelegationOptions() {
  return ALLOWED_OPERATIONS;
}

export function getDelegationPurposeOptions() {
  return DELEGATION_PURPOSE_OPTIONS;
}

export async function upsertUserByClaims(claims = {}) {
  const sub = normalizeSub(claims?.sub);
  if (!sub) {
    return null;
  }

  if (!getDbPool()) {
    return {
      id: null,
      sub,
      email: claims?.email || claims?.emails?.[0]?.value || null,
      full_name:
        claims?.fullName?.formatted ||
        claims?.name ||
        [claims?.given_name, claims?.family_name].filter(Boolean).join(" ").trim() ||
        null
    };
  }

  const email = claims?.email || claims?.emails?.[0]?.value || null;
  const fullName =
    claims?.fullName?.formatted ||
    claims?.name ||
    [claims?.given_name, claims?.family_name].filter(Boolean).join(" ").trim() ||
    null;

  const result = await dbQuery(
    `
      INSERT INTO users (id, sub, email, full_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (sub)
      DO UPDATE SET
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        updated_at = NOW()
      RETURNING id, sub, email, full_name
    `,
    [crypto.randomUUID(), sub, email, fullName]
  );
  return result.rows[0];
}

export async function recordAuthLogin(claims = {}) {
  const user = await upsertUserByClaims(claims);
  if (!user?.id || !getDbPool()) {
    return null;
  }

  await ensureUserAccountState(user.id);

  const exp = Number(claims?.exp);
  const idTokenExp = Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null;
  await dbQuery(
    `
      INSERT INTO auth_sessions (id, user_id, id_token_exp, metadata)
      VALUES ($1, $2, $3, $4::jsonb)
    `,
    [crypto.randomUUID(), user.id, idTokenExp, JSON.stringify({ provider: "onewelcome" })]
  );
  return user;
}

export async function recordAuthLogoutBySub(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return null;
  }

  await dbQuery(
    `
      UPDATE auth_sessions a
      SET logout_at = NOW()
      FROM users u
      WHERE u.id = a.user_id
        AND u.sub = $1
        AND a.logout_at IS NULL
    `,
    [normalizedSub]
  );
  return true;
}

export async function getDelegation(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return fallbackDelegation();
  }
  await ensureDelegationSchema();

  const result = await dbQuery(
    `
      SELECT d.idv_verified, d.idv_verified_at, d.delegated_operations, d.delegation_constraints
      FROM delegations d
      JOIN users u ON u.id = d.user_id
      WHERE u.sub = $1
      LIMIT 1
    `,
    [normalizedSub]
  );

  if (!result.rows.length) {
    return fallbackDelegation();
  }

  const row = result.rows[0];
  return {
    idvVerified: Boolean(row.idv_verified),
    idvVerifiedAt: row.idv_verified_at || null,
    delegatedOperations: safeJsonArray(row.delegated_operations),
    constraints: normalizeDelegationConstraints(row.delegation_constraints)
  };
}

export async function markIdvVerified(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub) {
    throw new Error("Missing subject");
  }
  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id || !getDbPool()) {
    return {
      idvVerified: true,
      idvVerifiedAt: new Date().toISOString(),
      delegatedOperations: [],
      constraints: { ...DEFAULT_DELEGATION_CONSTRAINTS }
    };
  }
  await ensureDelegationSchema();

  await dbQuery(
    `
      INSERT INTO delegations (user_id, idv_verified, idv_verified_at, delegated_operations, delegation_constraints, updated_at)
      VALUES ($1, TRUE, NOW(), '[]'::jsonb, '{}'::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        idv_verified = TRUE,
        idv_verified_at = NOW(),
        updated_at = NOW()
    `,
    [user.id]
  );
  return getDelegation(normalizedSub);
}

export async function markIdvFailed(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub) {
    throw new Error("Missing subject");
  }
  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id || !getDbPool()) {
    return fallbackDelegation();
  }
  await ensureDelegationSchema();

  await dbQuery(
    `
      INSERT INTO delegations (user_id, idv_verified, idv_verified_at, delegated_operations, delegation_constraints, updated_at)
      VALUES ($1, FALSE, NULL, '[]'::jsonb, '{}'::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        idv_verified = FALSE,
        idv_verified_at = NULL,
        updated_at = NOW()
    `,
    [user.id]
  );
  return getDelegation(normalizedSub);
}

export async function setDelegatedOperations(sub, requestedOperations, constraintsInput = {}) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub) {
    throw new Error("Missing subject");
  }

  const current = await getDelegation(normalizedSub);
  if (!current.idvVerified) {
    throw new Error("IDV_REQUIRED");
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id || !getDbPool()) {
    return current;
  }
  await ensureDelegationSchema();

  const allowed = new Set(ALLOWED_OPERATIONS.map((op) => op.key));
  const delegatedOperations = Array.from(
    new Set(
      (Array.isArray(requestedOperations) ? requestedOperations : [])
        .map((operation) => String(operation || "").trim())
        .filter((operation) => allowed.has(operation))
    )
  );

  const constraints = normalizeDelegationConstraints(constraintsInput);
  await dbQuery(
    `
      UPDATE delegations
      SET delegated_operations = $2::jsonb,
          delegation_constraints = $3::jsonb,
          updated_at = NOW()
      WHERE user_id = $1
    `,
    [user.id, JSON.stringify(delegatedOperations), JSON.stringify(constraints)]
  );

  return getDelegation(normalizedSub);
}

export async function isOperationDelegated(sub, operationKey) {
  if (!operationKey) {
    return true;
  }

  const record = await getDelegation(sub);
  if (!record.idvVerified) {
    return false;
  }
  return record.delegatedOperations.includes(operationKey);
}

function mapApprovalRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    sub: row.sub,
    approvalType: row.approval_type,
    status: row.status,
    reason: row.reason || null,
    payload: row.payload || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    resolvedBySub: row.resolved_by_sub || null
  };
}

export async function createOperationApproval(sub, approval = {}) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return null;
  }
  await ensureDelegationSchema();
  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return null;
  }
  const ttlSeconds = Math.max(30, Number(approval.ttlSeconds) || 600);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const id = crypto.randomUUID();

  await dbQuery(
    `
      INSERT INTO operation_approvals (
        id, user_id, approval_type, status, reason, payload, expires_at
      )
      VALUES ($1, $2, $3, 'pending', $4, $5::jsonb, $6)
    `,
    [
      id,
      user.id,
      String(approval.approvalType || "high_risk_transfer"),
      approval.reason ? String(approval.reason) : null,
      JSON.stringify(approval.payload || {}),
      expiresAt
    ]
  );

  const created = await getOperationApprovalById(id);
  return created;
}

export async function getOperationApprovalById(approvalId) {
  if (!approvalId || !getDbPool()) {
    return null;
  }
  await ensureDelegationSchema();
  const result = await dbQuery(
    `
      SELECT a.*, u.sub
      FROM operation_approvals a
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1
      LIMIT 1
    `,
    [String(approvalId)]
  );
  return mapApprovalRow(result.rows[0] || null);
}

export async function approveOperationById(sub, approvalId) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !approvalId || !getDbPool()) {
    return null;
  }
  await ensureDelegationSchema();
  const approval = await getOperationApprovalById(approvalId);
  if (!approval || approval.sub !== normalizedSub) {
    return null;
  }
  if (approval.status !== "pending") {
    return approval;
  }
  if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) {
    await dbQuery(
      `
        UPDATE operation_approvals
        SET status = 'expired',
            resolved_at = NOW(),
            resolved_by_sub = $2
        WHERE id = $1
      `,
      [String(approvalId), normalizedSub]
    );
    return getOperationApprovalById(approvalId);
  }

  await dbQuery(
    `
      UPDATE operation_approvals
      SET status = 'approved',
          resolved_at = NOW(),
          resolved_by_sub = $2
      WHERE id = $1
    `,
    [String(approvalId), normalizedSub]
  );
  return getOperationApprovalById(approvalId);
}

export async function verifyApprovedOperation(sub, approvalId, expectedType = null) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !approvalId) {
    return { ok: false, reason: "missing_approval" };
  }
  const approval = await getOperationApprovalById(approvalId);
  if (!approval || approval.sub !== normalizedSub) {
    return { ok: false, reason: "approval_not_found" };
  }
  if (expectedType && approval.approvalType !== expectedType) {
    return { ok: false, reason: "approval_type_mismatch" };
  }
  if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: "approval_expired" };
  }
  if (approval.status !== "approved") {
    return { ok: false, reason: "approval_not_approved" };
  }
  return { ok: true, approval };
}

export async function listPendingApprovals(sub, limit = 20) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return [];
  }
  await ensureDelegationSchema();
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await dbQuery(
    `
      SELECT a.*, u.sub
      FROM operation_approvals a
      JOIN users u ON u.id = a.user_id
      WHERE u.sub = $1
        AND a.status = 'pending'
        AND (a.expires_at IS NULL OR a.expires_at > NOW())
      ORDER BY a.created_at DESC
      LIMIT $2
    `,
    [normalizedSub, safeLimit]
  );
  return result.rows.map(mapApprovalRow);
}

export async function listAuthorizationEvents(sub, limit = 40) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return [];
  }
  await ensureDelegationSchema();
  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return [];
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);

  const transferResult = await dbQuery(
    `
      SELECT
        id,
        status,
        amount,
        to_account,
        risk_status,
        requires_step_up,
        step_up_verified,
        details,
        created_at
      FROM transfers
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [user.id, safeLimit]
  );

  const approvalResult = await dbQuery(
    `
      SELECT
        id,
        approval_type,
        status,
        reason,
        payload,
        created_at,
        expires_at,
        resolved_at
      FROM operation_approvals
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [user.id, safeLimit]
  );

  const transferEvents = transferResult.rows.map((row) => {
    const details = safeJsonObject(row.details);
    const reason =
      details?.message ||
      details?.reason ||
      details?.error ||
      (row.status === "completed" ? "Transfer completed." : null);
    return {
      id: `transfer:${row.id}`,
      category: "transfer_authorization",
      status: String(row.status || "unknown"),
      source: "transfer-policy-engine",
      reason: reason ? String(reason) : null,
      timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
      metadata: {
        amount: row.amount == null ? null : Number(row.amount),
        toAccount: row.to_account || null,
        riskStatus: row.risk_status || null,
        requiresStepUp: Boolean(row.requires_step_up),
        stepUpVerified: Boolean(row.step_up_verified)
      }
    };
  });

  const approvalEvents = approvalResult.rows.map((row) => ({
    id: `approval:${row.id}`,
    category: "out_of_band_approval",
    status: String(row.status || "unknown"),
    source: "approval-workflow",
    reason: row.reason || null,
    timestamp: row.resolved_at || row.created_at ? new Date(row.resolved_at || row.created_at).toISOString() : null,
    metadata: {
      approvalType: row.approval_type || null,
      payload: row.payload || {},
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null
    }
  }));

  return [...transferEvents, ...approvalEvents]
    .sort((a, b) => {
      const at = new Date(a.timestamp || 0).getTime();
      const bt = new Date(b.timestamp || 0).getTime();
      return bt - at;
    })
    .slice(0, safeLimit);
}

export async function createIdvSession(sub, metadata = {}) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub) {
    throw new Error("Missing subject");
  }
  const user = await upsertUserByClaims({ sub: normalizedSub });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  if (!user?.id || !getDbPool()) {
    return {
      id,
      sub: normalizedSub,
      status: "pending",
      createdAt: now,
      completedAt: null,
      scenarioId: null,
      metadata
    };
  }

  await dbQuery(
    `
      INSERT INTO idv_sessions (id, user_id, status, metadata)
      VALUES ($1, $2, 'pending', $3::jsonb)
    `,
    [id, user.id, JSON.stringify(metadata || {})]
  );
  return {
    id,
    sub: normalizedSub,
    status: "pending",
    createdAt: now,
    completedAt: null,
    scenarioId: null,
    metadata
  };
}

export async function getIdvSession(id) {
  if (!id || !getDbPool()) {
    return null;
  }

  const result = await dbQuery(
    `
      SELECT s.id, u.sub, s.status, s.scenario_id, s.metadata, s.created_at, s.completed_at
      FROM idv_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [String(id)]
  );
  if (!result.rows.length) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    sub: row.sub,
    status: row.status,
    scenarioId: row.scenario_id || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export async function completeIdvSession(id, status, scenarioId = null) {
  if (!id || !getDbPool()) {
    return null;
  }
  const normalizedStatus = status === "verified" ? "verified" : "failed";

  await dbQuery(
    `
      UPDATE idv_sessions
      SET status = $2,
          scenario_id = COALESCE($3, scenario_id),
          completed_at = NOW()
      WHERE id = $1
    `,
    [String(id), normalizedStatus, scenarioId]
  );
  return getIdvSession(id);
}

export async function createTransferRecord(sub, transferData = {}) {
  if (!getDbPool()) {
    return null;
  }

  const user = sub ? await upsertUserByClaims({ sub }) : null;
  const userId = user?.id || null;

  await dbQuery(
    `
      INSERT INTO transfers (
        id, user_id, transaction_id, status, amount, to_account, risk_status,
        requires_step_up, step_up_verified, details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    `,
    [
      crypto.randomUUID(),
      userId,
      transferData.transactionId || null,
      transferData.status || "unknown",
      transferData.amount ?? null,
      transferData.toAccount || null,
      transferData.riskStatus || "Normal",
      Boolean(transferData.requiresStepUp),
      Boolean(transferData.stepUpVerified),
      JSON.stringify(transferData.details || {})
    ]
  );
  return true;
}

export async function getLastTransfer(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return null;
  }

  const result = await dbQuery(
    `
      SELECT t.transaction_id, t.amount, t.to_account, t.created_at, t.status, t.risk_status
      FROM transfers t
      JOIN users u ON u.id = t.user_id
      WHERE u.sub = $1 AND t.status = 'completed'
      ORDER BY t.created_at DESC
      LIMIT 1
    `,
    [normalizedSub]
  );
  if (!result.rows.length) {
    return null;
  }
  const row = result.rows[0];
  return {
    transactionId: row.transaction_id,
    amount: Number(row.amount),
    toAccount: row.to_account,
    timestamp: new Date(row.created_at).toISOString(),
    status: row.status,
    riskStatus: row.risk_status
  };
}

export async function getAccountState(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return fallbackAccountState();
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return fallbackAccountState();
  }

  await ensureUserAccountState(user.id);

  const result = await dbQuery(
    `
      SELECT available_balance, savings_balance
      FROM account_balances
      WHERE user_id = $1
      LIMIT 1
    `,
    [user.id]
  );

  if (!result.rows.length) {
    return fallbackAccountState();
  }

  return mapAccountRow(result.rows[0]);
}

export async function getTransactionHistory(sub, limit = 10) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return [];
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return [];
  }

  await ensureUserAccountState(user.id);

  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const result = await dbQuery(
    `
      SELECT id, kind, amount, from_account, to_account, description,
             external_transaction_id, metadata, created_at
      FROM account_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [user.id, safeLimit]
  );

  return result.rows.map(mapHistoryRow);
}

export async function getUserFinancialState(sub, historyLimit = 8) {
  const [balances, transactionHistory, interactionStats] = await Promise.all([
    getAccountState(sub),
    getTransactionHistory(sub, historyLimit),
    getAgentInteractionStats(sub)
  ]);

  return { balances, transactionHistory, interactionStats };
}

export async function recordAgentInteraction(sub, interaction = {}) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return null;
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return null;
  }

  await ensureInteractionSchema();
  await ensureAccountSchema();

  await dbQuery(
    `
      INSERT INTO agent_interactions (
        id, user_id, question, intent, operation_key, answered, operation_performed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      crypto.randomUUID(),
      user.id,
      String(interaction.question || ""),
      interaction.intent ? String(interaction.intent) : null,
      interaction.operationKey ? String(interaction.operationKey) : null,
      Boolean(interaction.answered),
      Boolean(interaction.operationPerformed)
    ]
  );

  return true;
}

export async function getAgentInteractionStats(sub) {
  const normalizedSub = normalizeSub(sub);
  if (!normalizedSub || !getDbPool()) {
    return fallbackInteractionStats();
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return fallbackInteractionStats();
  }

  await ensureInteractionSchema();

  const result = await dbQuery(
    `
      SELECT
        COUNT(*)::int AS questions_asked,
        COUNT(*) FILTER (WHERE answered = TRUE)::int AS questions_answered,
        COUNT(*) FILTER (WHERE operation_performed = TRUE)::int AS interaction_operations_performed
      FROM agent_interactions
      WHERE user_id = $1
    `,
    [user.id]
  );

  const opCountResult = await dbQuery(
    `
      SELECT COUNT(*)::int AS transfer_operations_performed
      FROM account_transactions
      WHERE user_id = $1
        AND kind = 'transfer'
    `,
    [user.id]
  );

  const row = result.rows[0] || {};
  const opCountRow = opCountResult.rows[0] || {};
  return {
    questionsAsked: Number(row.questions_asked || 0),
    questionsAnswered: Number(row.questions_answered || 0),
    operationsPerformed: Number(opCountRow.transfer_operations_performed || row.interaction_operations_performed || 0)
  };
}

export async function applyTransferAndUpdateBalances(sub, transferData = {}) {
  const normalizedSub = normalizeSub(sub);
  const amount = Number(transferData.amount);
  const toAccount = String(transferData.toAccount || "").trim();
  const fromAccount = String(transferData.fromAccount || "").trim();

  if (!normalizedSub || !getDbPool()) {
    return {
      ok: false,
      code: "ACCOUNT_STATE_UNAVAILABLE",
      message: "Account state is unavailable. Please authenticate and try again."
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "Invalid transfer amount."
    };
  }

  const user = await upsertUserByClaims({ sub: normalizedSub });
  if (!user?.id) {
    return {
      ok: false,
      code: "ACCOUNT_STATE_UNAVAILABLE",
      message: "Unable to resolve account holder."
    };
  }

  await ensureUserAccountState(user.id);

  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const balanceResult = await client.query(
      `
        SELECT available_balance, savings_balance
        FROM account_balances
        WHERE user_id = $1
        FOR UPDATE
      `,
      [user.id]
    );

    if (!balanceResult.rows.length) {
      throw new Error("Missing account balance row");
    }

    const currentAvailable = normalizeAmount(balanceResult.rows[0].available_balance);
    const currentSavings = normalizeAmount(balanceResult.rows[0].savings_balance);

    const resolvedTo = resolveInternalAccountName(toAccount, "available");
    const resolvedFrom = resolveInternalAccountName(fromAccount, resolvedTo === "savings" ? "available" : "savings");

    if (resolvedFrom === resolvedTo) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "INVALID_TRANSFER_DIRECTION",
        message: "Source and destination accounts must be different."
      };
    }

    const availableForSource = resolvedFrom === "savings" ? currentSavings : currentAvailable;
    if (amount > availableForSource) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "INSUFFICIENT_FUNDS",
        message: `Insufficient funds. ${resolvedFrom} balance is ${availableForSource.toFixed(2)}.`
      };
    }

    const nextAvailable = normalizeAmount(
      currentAvailable + (resolvedTo === "available" ? amount : 0) - (resolvedFrom === "available" ? amount : 0)
    );
    const nextSavings = normalizeAmount(
      currentSavings + (resolvedTo === "savings" ? amount : 0) - (resolvedFrom === "savings" ? amount : 0)
    );

    await client.query(
      `
        UPDATE account_balances
        SET available_balance = $2,
            savings_balance = $3,
            updated_at = NOW()
        WHERE user_id = $1
      `,
      [user.id, nextAvailable, nextSavings]
    );

    const txDescription = `Transfer from ${resolvedFrom} to ${resolvedTo}`;

    await client.query(
      `
        INSERT INTO account_transactions (
          id, user_id, kind, amount, from_account, to_account, description,
          external_transaction_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        crypto.randomUUID(),
        user.id,
        "transfer",
        amount,
        resolvedFrom,
        resolvedTo,
        txDescription,
        transferData.transactionId || null,
        JSON.stringify({
          riskStatus: transferData.riskStatus || "Normal",
          requiresStepUp: Boolean(transferData.requiresStepUp),
          stepUpVerified: Boolean(transferData.stepUpVerified),
          requestedFromAccount: fromAccount || null,
          requestedToAccount: toAccount || null,
          operationSource: transferData.operationSource || "prompt",
          automationExecutionType: transferData.automationExecutionType || null,
          automationRuleId: transferData.automationRuleId || null,
          delegatedBy: transferData.delegatedBy || null,
          delegationScope: Array.isArray(transferData.delegationScope) ? transferData.delegationScope : [],
          executionTimestamp: transferData.executionTimestamp || null,
          authContext: transferData.authContext || null,
          authClientId: transferData.authClientId || null,
          authScopes: Array.isArray(transferData.authScopes) ? transferData.authScopes : []
        })
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      balances: {
        availableBalance: nextAvailable,
        savingsBalance: nextSavings
      }
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
