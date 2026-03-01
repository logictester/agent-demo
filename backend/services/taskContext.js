import { dbQuery, getDbPool } from "./db.js";

let taskContextSchemaReady = null;

async function ensureTaskContextSchema() {
  if (!getDbPool()) {
    return;
  }

  if (!taskContextSchemaReady) {
    taskContextSchemaReady = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS agent_task_contexts (
          context_key TEXT PRIMARY KEY,
          context_type TEXT NOT NULL DEFAULT 'generic',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ
        )
      `);

      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_agent_task_contexts_expires_at
        ON agent_task_contexts(expires_at)
      `);
    })().catch((error) => {
      taskContextSchemaReady = null;
      throw error;
    });
  }

  await taskContextSchemaReady;
}

function normalizeKey(contextKey) {
  return String(contextKey || "").trim();
}

export async function getTaskContext(contextKey, contextType = "generic") {
  if (!getDbPool()) {
    return null;
  }
  const key = normalizeKey(contextKey);
  if (!key) {
    return null;
  }

  await ensureTaskContextSchema();
  await deleteExpiredTaskContexts();

  const result = await dbQuery(
    `
      SELECT payload
      FROM agent_task_contexts
      WHERE context_key = $1
        AND context_type = $2
      LIMIT 1
    `,
    [key, String(contextType || "generic")]
  );

  if (!result.rows.length) {
    return null;
  }
  return result.rows[0].payload || null;
}

export async function upsertTaskContext(contextKey, payload, options = {}) {
  if (!getDbPool()) {
    return false;
  }
  const key = normalizeKey(contextKey);
  if (!key) {
    return false;
  }

  await ensureTaskContextSchema();
  const contextType = String(options.contextType || "generic");
  const ttlSeconds = Number(options.ttlSeconds);
  const expiresAt =
    Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
      : null;

  await dbQuery(
    `
      INSERT INTO agent_task_contexts (context_key, context_type, payload, updated_at, expires_at)
      VALUES ($1, $2, $3::jsonb, NOW(), $4)
      ON CONFLICT (context_key)
      DO UPDATE SET
        context_type = EXCLUDED.context_type,
        payload = EXCLUDED.payload,
        updated_at = NOW(),
        expires_at = EXCLUDED.expires_at
    `,
    [key, contextType, JSON.stringify(payload || {}), expiresAt]
  );

  return true;
}

export async function clearTaskContext(contextKey, contextType = "generic") {
  if (!getDbPool()) {
    return false;
  }
  const key = normalizeKey(contextKey);
  if (!key) {
    return false;
  }

  await ensureTaskContextSchema();
  await dbQuery(
    `
      DELETE FROM agent_task_contexts
      WHERE context_key = $1
        AND context_type = $2
    `,
    [key, String(contextType || "generic")]
  );
  return true;
}

export async function deleteExpiredTaskContexts() {
  if (!getDbPool()) {
    return 0;
  }
  await ensureTaskContextSchema();
  const result = await dbQuery(
    `
      DELETE FROM agent_task_contexts
      WHERE expires_at IS NOT NULL
        AND expires_at <= NOW()
    `
  );
  return Number(result.rowCount || 0);
}
