import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const {
  ONEWELCOME_BASE_URL,
  ONEWELCOME_CLIENT_ID,
  ONEWELCOME_CLIENT_SECRET,
  ONEWELCOME_REDIRECT_URI
} = process.env;

export async function exchangeCodeForToken(code) {
  if (!code) {
    throw new Error("Missing OAuth authorization code");
  }

  if (
    !ONEWELCOME_BASE_URL ||
    !ONEWELCOME_CLIENT_ID ||
    !ONEWELCOME_CLIENT_SECRET ||
    !ONEWELCOME_REDIRECT_URI
  ) {
    throw new Error("Missing required OneWelcome environment variables");
  }

  const response = await axios.post(
    `${ONEWELCOME_BASE_URL}/oauth/v1/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: ONEWELCOME_CLIENT_ID,
      client_secret: ONEWELCOME_CLIENT_SECRET,
      redirect_uri: ONEWELCOME_REDIRECT_URI,
      scope: "openid profile email"
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data;
}

export async function refreshTokenGrant(refreshToken) {
  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }

  if (
    !ONEWELCOME_BASE_URL ||
    !ONEWELCOME_CLIENT_ID ||
    !ONEWELCOME_CLIENT_SECRET
  ) {
    throw new Error("Missing required OneWelcome environment variables");
  }

  const response = await axios.post(
    `${ONEWELCOME_BASE_URL}/oauth/v1/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ONEWELCOME_CLIENT_ID,
      client_secret: ONEWELCOME_CLIENT_SECRET,
      scope: "openid profile email"
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data;
}

export async function getUserInfo(accessToken) {
  const response = await axios.get(
    `${ONEWELCOME_BASE_URL}/oauth/v1/userinfo`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  return response.data;
}

export function decodeJwtClaims(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
