CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  sub TEXT UNIQUE NOT NULL,
  email TEXT,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_token_exp TIMESTAMPTZ,
  login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  logout_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS delegations (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  idv_verified BOOLEAN NOT NULL DEFAULT FALSE,
  idv_verified_at TIMESTAMPTZ,
  delegated_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
  delegation_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS idv_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  scenario_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  transaction_id TEXT,
  status TEXT NOT NULL,
  amount NUMERIC(14,2),
  to_account TEXT,
  risk_status TEXT NOT NULL,
  requires_step_up BOOLEAN NOT NULL DEFAULT FALSE,
  step_up_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS account_balances (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_balance NUMERIC(14,2) NOT NULL DEFAULT 24982.14,
  savings_balance NUMERIC(14,2) NOT NULL DEFAULT 7410.00,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS agent_interactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT,
  intent TEXT,
  operation_key TEXT,
  answered BOOLEAN NOT NULL DEFAULT FALSE,
  operation_performed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_task_contexts (
  context_key TEXT PRIMARY KEY,
  context_type TEXT NOT NULL DEFAULT 'generic',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

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
);

CREATE TABLE IF NOT EXISTS stock_portfolios (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_trading_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cash NUMERIC(14,2) NOT NULL DEFAULT 100000.00,
  positions JSONB NOT NULL DEFAULT '{}'::jsonb,
  trade_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_trade JSONB,
  pulse_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_decision_at BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_sub ON users(sub);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_idv_sessions_user_id ON idv_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_approvals_user_status
  ON operation_approvals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_approvals_expires_at
  ON operation_approvals(expires_at);
CREATE INDEX IF NOT EXISTS idx_transfers_user_id_created_at ON transfers(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_transactions_user_id_created_at
  ON account_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_interactions_user_id_created_at
  ON agent_interactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_task_contexts_expires_at
  ON agent_task_contexts(expires_at);
CREATE INDEX IF NOT EXISTS idx_transfer_automation_rules_user_id
  ON transfer_automation_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_transfer_automation_rules_next_run
  ON transfer_automation_rules(enabled, mode, next_run_at);

ALTER TABLE transfer_automation_rules
  ADD COLUMN IF NOT EXISTS schedule_type TEXT NOT NULL DEFAULT 'custom_interval';
ALTER TABLE transfer_automation_rules
  ADD COLUMN IF NOT EXISTS schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE transfer_automation_rules
  ADD COLUMN IF NOT EXISTS adaptive_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE delegations
  ADD COLUMN IF NOT EXISTS delegation_constraints JSONB NOT NULL DEFAULT '{}'::jsonb;
