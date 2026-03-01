# Agent Demo: AI Banking Assistant (Ollama + OneWelcome + OneWelcome IO + OneWelcome IDV + Postgres)

## 1) What This App Is

This project is a full-stack banking assistant demo where **all user-facing assistant behavior is powered by Ollama (Llama)** and wrapped with deterministic security controls.

It demonstrates:
- OIDC login/logout and token refresh with OneWelcome.
- Step-up re-authentication for high-risk actions.
- IDV-based delegation with OneWelcome IO using OneWelcome IDV services.
- Prompt-driven banking actions (transfers, identity, history, policy Q&A).
- Prompt-driven automation rule creation/editing/execution.
- Scheduled automation with machine-to-machine (M2M) credentials.
- Persistent state in Postgres (balances, transactions, sessions, delegation, rules, telemetry).

---

## 2) Core Capabilities

### Prompt-driven agent capabilities
- `transfer_funds`: transfer between available/savings.
- `view_identity`: explain who the user is from verified token claims.
- `view_last_transfer`: summarize most recent successful transfer.
- `view_transaction_history`: return persisted history.
- `manage_automations`: create/update/list/run balance-based automation rules via prompts.
- `explain_policy`: explain risk levels and step-up policy.
- `general_question`: non-operational assistant responses.

### UI capabilities
- Account stats (available, savings, risk, questions asked/answered, operations performed).
- Recent activity list with pagination + refresh button.
- Performed operations modal with filters:
  - prompt vs automation
  - automation mode: on-demand vs scheduled
- Prompt history dropdown (last 10 questions).
- Session expiry/warning modal with refresh or full re-login.
- Settings panel for delegation + scheduler configuration.
- Rule enable/disable slider in both settings and main page.
- Rule run/edit/delete actions in settings and main page.
- Decision flow visibility (“How it reached this”) for assistant + automation runs.

---

## 3) Technology Stack

- **Backend**: Node.js 20, Express
- **AI runtime**: LangChain `Ollama` LLM wrapper
- **Model**: `llama3.1:8b` (configurable)
- **Database**: PostgreSQL 16
- **AuthN/AuthZ**: OneWelcome OIDC/OAuth2
- **IDV orchestration**: OneWelcome IO flow integration
- **Frontend**: static HTML/CSS/JS (served by Express)
- **Containerization**: Docker + Docker Compose

---

## 4) High-Level Architecture

```mermaid
flowchart LR
  U[User Browser UI] -->|Prompt/API calls| B[Express Backend]
  B -->|Intent + response generation| O[Ollama Llama]
  B -->|OIDC/OAuth| I[OneWelcome]
  B -->|Start/callback IDV flow| M[OneWelcome IO]
  B -->|Persist state| D[(PostgreSQL)]

  S[Automation Scheduler] --> B
  B -->|M2M client_credentials| I
```

### Backend modules
- `backend/routes/*.js`: HTTP API surface.
- `backend/agent/agent.js`: Llama orchestration, intent classification, response generation, prompt-based automation management.
- `backend/services/automation.js`: rule engine, AI policy decision for rule execution, scheduler, M2M token use.
- `backend/services/delegation.js`: delegation/IDV state, balances, transactions, telemetry.
- `backend/services/onewelcome.js`: OAuth token exchange/refresh + userinfo.
- `backend/services/stepup.js`: signed short-lived step-up tickets.
- `backend/services/m2m.js`: cached client-credentials token retrieval.

---

## 5) How Llama Is Used

Llama is used in **two primary execution lanes**:

## 5.1 Interactive Agent Lane (`/agent`)
1. Classify user intent using Llama with strict capability context.
2. Resolve operation path (transfer/identity/history/policy/automation/general).
3. Run deterministic checks (auth/delegation/step-up/risk/validation).
4. For successful or blocked outcomes, call Llama again to synthesize a user-facing response **only from trusted facts**.

## 5.2 Automation Policy Lane (`/automation` + scheduler)
1. Load due/manual automation rule.
2. Build policy context (balances, thresholds, schedule mode, transfer amount).
3. Ask Llama policy engine to output strict JSON decision:
   - `execute` or `skip`
   - reason
   - risk status
   - decision flow steps
4. Enforce deterministic guardrails after AI decision.
5. Execute transfer/persist audit/advance schedule when valid.

---

## 6) What Was Done to "Teach" Llama the App

This project does **not** fine-tune the model. It teaches behavior through:

1. **Capability map and operation keys**
   - `CAPABILITIES` in `backend/agent/prompt.js` defines valid intents and schemas.

2. **Strong system prompt constraints**
   - Instructs model to avoid fabrication and honor policy/context facts.

3. **Structured JSON extraction/parsing**
   - Multiple helper parsers force machine-readable outputs for intent and automation parsing.

4. **Fact-grounded response synthesis**
   - Llama receives only trusted backend facts for final response generation.

5. **Contextual draft memory for prompt-based automation creation**
   - Pending automation drafts are tracked in memory (TTL 15 minutes).
   - Missing fields trigger follow-up questions.
   - Short follow-up replies (e.g., `1000`, `savings`, `yes`) are merged back into the same draft.

6. **Explicit confirmation workflow**
   - Prompt-created rules are previewed first.
   - Creation occurs only after affirmative confirmation (`yes`, `confirm`, etc.).

7. **Deterministic fallback and guardrails**
   - Regex and heuristic extraction backstop parsing.
   - Deterministic checks can block AI-proposed actions if policy is violated.

---

## 7) Security and Guardrails

## 7.1 Authentication and Identity
- OIDC login via OneWelcome authorization code flow.
- Access token validated through `/userinfo` before privileged operations.
- ID token claims are merged for identity responses.
- Refresh token flow supported (`/auth/refresh`).
- RP-initiated logout via OneWelcome logout endpoint.

## 7.2 Delegation and IDV gating
- Privileged operations require:
  - authenticated user,
  - IDV verified status,
  - operation included in delegated scope.
- If missing, operation is blocked with explicit reason.

## 7.3 High-risk transfer protection
- Policy threshold: amount `> 100` => high risk.
- Requires successful step-up re-authentication (`prompt=login&max_age=0`).
- Step-up ticket is signed (HMAC), short-lived, and subject-bound.

## 7.4 Automation safeguards
- Rule validation:
  - positive transfer amount
  - non-negative min balance
  - source/destination must differ
  - schedule config validity
- Post-AI deterministic guardrails still enforce:
  - skip when balance below threshold
  - skip scheduled execution if amount exceeds high-risk threshold
- Scheduled runs require M2M token retrieval; failures are surfaced and audited.

## 7.5 IDV callback protection
- Signed `state` (HMAC + expiry) for OneWelcome IO callback integrity.
- Optional callback secret header support.

## 7.6 Data safety patterns
- DB transaction with row lock for balance updates (`FOR UPDATE`).
- Insufficient funds and invalid direction checks.
- Detailed operation metadata persisted for audit trail.

---

## 8) Data Model (Postgres)

Key tables in `backend/db/init.sql`:

- `users`: canonical user record by `sub`.
- `auth_sessions`: login/logout + token expiry metadata.
- `delegations`: IDV status + delegated operation scope.
- `idv_sessions`: IDV attempts and outcomes.
- `transfers`: transfer lifecycle records (blocked/failed/completed).
- `account_balances`: available/savings balances.
- `account_transactions`: immutable transfer ledger + metadata.
- `agent_interactions`: question/answer + operation telemetry.
- `transfer_automation_rules`: scheduler rules, enable flag, next/last run, adaptive config.

---

## 9) API Surface

### Auth routes
- `GET /auth/login`
- `GET /auth/callback`
- `GET /auth/logout`
- `GET /auth/logout/callback`
- `POST /auth/refresh`
- `GET /auth/session-config`

### Agent routes
- `POST /agent`
- `GET /agent/state`

### Delegation routes
- `GET /delegation/options`
- `GET /delegation/status`
- `POST /delegation/idv/start`
- `GET /delegation/idv/callback`
- `POST /delegation/idv/callback`
- `POST /delegation/grants`

### Automation routes
- `GET /automation/rules`
- `POST /automation/rules`
- `PUT /automation/rules/:id`
- `DELETE /automation/rules/:id`
- `POST /automation/rules/:id/run`

---

## 10) End-to-End Flows

## 10.1 Normal transfer via prompt

```mermaid
sequenceDiagram
  participant UI as Browser UI
  participant API as /agent
  participant LLM as Ollama (Llama)
  participant DB as Postgres

  UI->>API: POST /agent {"message":"transfer 50 to savings"}
  API->>LLM: classify intent + args
  LLM-->>API: transfer_funds
  API->>DB: validate delegation + get balances
  API->>DB: apply transfer txn + insert history
  API->>LLM: synthesize response from trusted facts
  LLM-->>API: final natural-language answer
  API-->>UI: output + balances + history + decisionFlow + source/model
```

## 10.2 High-risk transfer requiring step-up

```mermaid
sequenceDiagram
  participant UI as Browser UI
  participant API as /agent
  participant AUTH as OneWelcome

  UI->>API: transfer amount > 100
  API-->>UI: requiresReauth=true, reauthUrl
  UI->>AUTH: /auth/login?stepup=1
  AUTH-->>UI: callback with fresh tokens + stepUpTicket
  UI->>API: resend operation with stepUp ticket
  API-->>UI: transfer executes if all checks pass
```

## 10.3 Scheduled automation execution with M2M

```mermaid
sequenceDiagram
  participant SCH as Scheduler
  participant API as automation service
  participant LLM as Ollama policy engine
  participant IDP as OneWelcome token endpoint
  participant DB as Postgres

  SCH->>API: evaluate due rules
  API->>DB: load enabled scheduled rules
  API->>LLM: execute/skip decision JSON
  LLM-->>API: action + reason + risk + flow
  API->>IDP: client_credentials token request (M2M)
  IDP-->>API: access token + scopes
  API->>DB: apply transfer + audit metadata + next_run_at
```

## 10.4 Prompt-based automation creation with context carry

```mermaid
flowchart TD
  A[User: Create scheduled rule...] --> B[LLM parse draft]
  B --> C{Missing fields?}
  C -- Yes --> D[Ask follow-up question]
  D --> E[User provides short reply]
  E --> F[Merge into pending draft]
  F --> C
  C -- No --> G[Show creation preview]
  G --> H{User confirms?}
  H -- Yes --> I[Persist rule in DB]
  H -- No --> J[Cancel operation]
```

---

## 11) Session UX Behavior

- Session warning threshold is configurable (`SESSION_WARNING_SECONDS`).
- If session is near expiry:
  - modal shows **Continue session** (refresh token path).
- If session expired:
  - modal shows **Login again** (full OIDC login, not refresh-only).
- UI clears stale prompt text and keeps prompt history separately.

---

## 12) Configuration

Start from the committed template:

```bash
cp backend/.env.example backend/.env
```

Create `backend/.env` with values like:

```env
PORT=4000
DATABASE_URL=postgres://agent:agentpass@localhost:5432/agent_demo

ONEWELCOME_BASE_URL=https://<your-onewelcome-domain>
ONEWELCOME_CLIENT_ID=<web-client-id>
ONEWELCOME_CLIENT_SECRET=<web-client-secret>
ONEWELCOME_REDIRECT_URI=http://localhost:4000/auth/callback
ONEWELCOME_POST_LOGOUT_REDIRECT_URI=http://localhost:4000/auth/logout/callback
ONEWELCOME_LOGOUT_URL=https://<your-onewelcome-domain>/oauth/v1/logout

OLLAMA_BASE_URL=http://<ollama-host>:11434
OLLAMA_MODEL=llama3.1:8b
AGENT_DEBUG=false

STEP_UP_SECRET=<long-random-secret>
STEP_UP_TTL_SECONDS=300

MONOKEE_IDV_START_URL=https://<onewelcome-io-flow-start-url>
MONOKEE_IDV_STATE_SECRET=<long-random-secret>
MONOKEE_IDV_STATE_TTL_SECONDS=900
MONOKEE_IDV_CALLBACK_SECRET=

SESSION_WARNING_SECONDS=120

AUTOMATION_EVALUATOR_SECONDS=60
AUTOMATION_MIN_INTERVAL_MINUTES=1

ONEWELCOME_M2M_TOKEN_URL=https://<your-onewelcome-domain>/oauth/v1/token
ONEWELCOME_M2M_CLIENT_ID=<m2m-client-id>
ONEWELCOME_M2M_CLIENT_SECRET=<m2m-client-secret>
ONEWELCOME_M2M_SCOPES=automation:execute accounts:read transfers:write audit:write
```

> Security note: do not commit real secrets to source control. Rotate any exposed values.

---

## 13) Running the App

## Option A: Docker Compose (recommended)

```bash
docker compose up --build
```

Services:
- backend: `http://localhost:4000`
- postgres: `localhost:5432`

## Option B: Local Node + local Postgres

```bash
cd backend
npm ci
npm start
```

Open: `http://localhost:4000`

---

## 14) How to Demo Llama-Centric Behavior

Try prompts like:
- `who am i`
- `what are the risk levels`
- `transfer 50 from available to savings`
- `transfer 150 to savings` (should trigger step-up)
- `create a scheduled balance based rule to run every 1 minute and transfer 10 from balance to savings`
- Follow-up: `minimum balance is 1000`
- Then: `yes` (to confirm creation)
- `run my weekly savings rule now`
- `list my automation rules`

In responses, inspect:
- `source: ollama`
- `model: llama3.1:8b` (or configured model)
- `How it reached this` decision flow

---

## 15) Operational Notes and Current Boundaries

- Prompt-based draft context for automation creation is **in-memory** with TTL and keyed by user/conversation; it resets on server restart.
- Persisted artifacts (balances, transactions, delegation, rules, stats) live in Postgres and survive refresh/restart.
- Scheduled runs use M2M context and do not require active browser session.
- Deterministic safeguards can override AI “execute” decisions when policy constraints are violated.

---

## 16) File Map

- Backend entry: `backend/server.js`
- Agent orchestration: `backend/agent/agent.js`
- Prompt and capabilities: `backend/agent/prompt.js`
- Transfer parsing/tooling: `backend/agent/tools.js`
- Auth routes: `backend/routes/auth.js`
- Agent routes: `backend/routes/agent.js`
- Delegation + IDV routes: `backend/routes/delegation.js`
- Automation routes: `backend/routes/automation.js`
- Delegation + balances + telemetry service: `backend/services/delegation.js`
- Automation + scheduler + AI decision service: `backend/services/automation.js`
- OIDC helper service: `backend/services/onewelcome.js`
- Step-up ticket service: `backend/services/stepup.js`
- M2M token service: `backend/services/m2m.js`
- DB schema: `backend/db/init.sql`
- Frontend app: `frontend/index.html`

---

## 17) Troubleshooting

### App says server started but UI inaccessible
- Verify container port mapping: `4000:4000`.
- Confirm backend serves frontend directory (`/frontend`).
- Check CORS/network if UI is hosted separately.

### Agent returns empty or malformed output
- Verify Ollama host/model are reachable.
- Ensure `OLLAMA_BASE_URL` points to reachable endpoint.
- Confirm model exists on Ollama host.

### Scheduled rules not running
- Ensure rule is enabled and mode is `scheduled`.
- Check `next_run_at` and scheduler interval (`AUTOMATION_EVALUATOR_SECONDS`).
- For scheduled execution, verify M2M env vars and token endpoint/scopes.

### IDV callback fails
- Validate OneWelcome IO callback includes correct signed `state`.
- If `MONOKEE_IDV_CALLBACK_SECRET` is set, callback must send matching header.

---

## 18) Summary

This demo combines Llama-driven intent/policy reasoning with strict identity, delegation, and transactional guardrails. It is designed to show how an AI assistant can safely execute sensitive financial operations by combining:
- model reasoning,
- deterministic policy enforcement,
- auditable persistence,
- and standards-based identity/authorization.
