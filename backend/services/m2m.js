import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_EXPIRES_IN_SECONDS = 300;
let tokenCache = null;

function resolveTokenEndpoint() {
  const explicit = String(process.env.ONEWELCOME_M2M_TOKEN_URL || "").trim();
  if (explicit) {
    return explicit;
  }
  const base = String(process.env.ONEWELCOME_BASE_URL || "").trim();
  return base ? `${base}/oauth/v1/token` : "";
}

function resolveScopes() {
  const raw = String(process.env.ONEWELCOME_M2M_SCOPES || "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .join(" ");
}

function parseScopeList(scopeString) {
  return String(scopeString || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export async function getMachineAccessToken() {
  const tokenEndpoint = resolveTokenEndpoint();
  const clientId = String(process.env.ONEWELCOME_M2M_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ONEWELCOME_M2M_CLIENT_SECRET || "").trim();
  const requestedScope = resolveScopes();

  if (!tokenEndpoint || !clientId || !clientSecret) {
    throw new Error("M2M_CONFIG_MISSING");
  }

  const now = Date.now();
  if (tokenCache?.accessToken && Number(tokenCache.expiresAtMs) - now > 10000) {
    return tokenCache;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });
  if (requestedScope) {
    body.set("scope", requestedScope);
  }

  const response = await axios.post(tokenEndpoint, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  const data = response?.data || {};
  const accessToken = String(data.access_token || "").trim();
  if (!accessToken) {
    throw new Error("M2M_TOKEN_MISSING");
  }

  const expiresIn = Math.max(Number(data.expires_in) || DEFAULT_EXPIRES_IN_SECONDS, 30);
  const expiresAtMs = now + expiresIn * 1000;
  const scope = String(data.scope || requestedScope || "").trim();

  tokenCache = {
    accessToken,
    tokenType: String(data.token_type || "Bearer"),
    scope,
    scopeList: parseScopeList(scope),
    clientId,
    tokenEndpoint,
    expiresAtMs
  };
  return tokenCache;
}

