import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const STEP_UP_SECRET = process.env.STEP_UP_SECRET || "change-this-step-up-secret";
const STEP_UP_TTL_SECONDS = Number(process.env.STEP_UP_TTL_SECONDS) || 300;

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const withPadding = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return Buffer.from(withPadding, "base64").toString("utf8");
}

function sign(content) {
  return crypto.createHmac("sha256", STEP_UP_SECRET).update(content).digest("base64url");
}

export function createStepUpTicket({ sub }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "STEPUP" };
  const payload = {
    sub: String(sub || ""),
    iat: now,
    exp: now + STEP_UP_TTL_SECONDS
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`);

  return {
    token: `${encodedHeader}.${encodedPayload}.${signature}`,
    exp: payload.exp
  };
}

export function verifyStepUpTicket(ticket, expectedSub) {
  if (!ticket || typeof ticket !== "string") {
    return { valid: false, reason: "missing_ticket" };
  }

  const parts = ticket.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "invalid_format" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return { valid: false, reason: "invalid_signature" };
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (!payload?.exp || now >= Number(payload.exp)) {
      return { valid: false, reason: "expired" };
    }

    if (expectedSub && String(payload.sub) !== String(expectedSub)) {
      return { valid: false, reason: "subject_mismatch" };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "invalid_payload" };
  }
}
