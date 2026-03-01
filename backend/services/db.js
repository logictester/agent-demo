import { Pool } from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const connectionString = process.env.DATABASE_URL || "";

let pool = null;

export function getDbPool() {
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    pool = new Pool({ connectionString });
  }

  return pool;
}

export async function dbQuery(text, params = []) {
  const activePool = getDbPool();
  if (!activePool) {
    throw new Error("DATABASE_URL is not configured");
  }

  return activePool.query(text, params);
}
