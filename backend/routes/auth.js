import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createStepUpTicket } from "../services/stepup.js";
import {
  exchangeCodeForToken,
  getUserInfo,
  decodeJwtClaims,
  refreshTokenGrant
} from "../services/onewelcome.js";
import { recordAuthLogin, recordAuthLogoutBySub } from "../services/delegation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const router = express.Router();

function encodeState(state) {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeState(state) {
  if (!state || typeof state !== "string") {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

router.get("/session-config", (req, res) => {
  const warning = Number(process.env.SESSION_WARNING_SECONDS);
  const warningSeconds = Number.isFinite(warning) && warning > 0 ? Math.floor(warning) : 120;
  return res.json({ sessionWarningSeconds: warningSeconds });
});

router.get("/login", (req, res) => {
  if (
    !process.env.ONEWELCOME_BASE_URL ||
    !process.env.ONEWELCOME_CLIENT_ID ||
    !process.env.ONEWELCOME_REDIRECT_URI
  ) {
    return res.status(500).json({
      error: "Missing OneWelcome environment variables"
    });
  }

  const isStepUp = String(req.query.stepup || "") === "1";
  const isReauth = String(req.query.reauth || "") === "1";
  const returnTo =
    typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/")
      ? req.query.returnTo
      : "/";
  const state = encodeState({
    stepup: isStepUp,
    returnTo
  });

  const query = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ONEWELCOME_CLIENT_ID,
    redirect_uri: process.env.ONEWELCOME_REDIRECT_URI,
    scope: "openid profile email",
    state
  });

  if (isStepUp || isReauth) {
    query.set("prompt", "login");
    query.set("max_age", "0");
  }

  const authUrl = `${process.env.ONEWELCOME_BASE_URL}/oauth/v1/authorize?${query.toString()}`;

  res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const decodedState = decodeState(req.query.state);
  const isStepUp = Boolean(decodedState?.stepup);
  const returnTo =
    typeof decodedState?.returnTo === "string" && decodedState.returnTo.startsWith("/")
      ? decodedState.returnTo
      : "/";

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    const tokenData = await exchangeCodeForToken(code);
    const idTokenClaims = decodeJwtClaims(tokenData.id_token || "");
    if (idTokenClaims?.sub) {
      try {
        await recordAuthLogin(idTokenClaims);
      } catch {
        // Auth persistence should not block user login flow.
      }
    }
    const safeToken = JSON.stringify(tokenData.access_token ?? "");
    const safeIdToken = JSON.stringify(tokenData.id_token ?? "");
    const safeRefreshToken = JSON.stringify(tokenData.refresh_token ?? "");
    let stepUpToken = "";
    let stepUpExp = 0;

    if (isStepUp && tokenData.access_token) {
      const userInfo = await getUserInfo(tokenData.access_token);
      const issued = createStepUpTicket({ sub: userInfo?.sub || "unknown" });
      stepUpToken = issued.token;
      stepUpExp = issued.exp;
    }

    const safeStepUpToken = JSON.stringify(stepUpToken);
    const safeStepUpExp = JSON.stringify(stepUpExp);
    const safeReturnTo = JSON.stringify(returnTo);

    return res.send(`
      <script>
        localStorage.setItem("access_token", ${safeToken});
        localStorage.setItem("id_token", ${safeIdToken});
        localStorage.setItem("refresh_token", ${safeRefreshToken});
        if (${isStepUp ? "true" : "false"}) {
          localStorage.setItem("helio.stepUpTicket", ${safeStepUpToken});
          localStorage.setItem("helio.stepUpTicketExp", ${safeStepUpExp});
          localStorage.setItem("helio.stepUpCompletedAt", String(Date.now()));
        }
        window.location.href = ${safeReturnTo};
      </script>
    `);
  } catch (error) {
    const message = error?.response?.data?.error_description || error.message;
    return res.status(500).send(`OAuth callback failed: ${message}`);
  }
});

router.get("/logout", (req, res) => {
  const idTokenHint = typeof req.query.id_token_hint === "string" ? req.query.id_token_hint : "";
  const postLogoutRedirectUri =
    process.env.ONEWELCOME_POST_LOGOUT_REDIRECT_URI || "http://localhost:4000/auth/logout/callback";
  const logoutEndpoint =
    process.env.ONEWELCOME_LOGOUT_URL ||
    (process.env.ONEWELCOME_BASE_URL
      ? `${process.env.ONEWELCOME_BASE_URL}/oauth/v1/logout`
      : "");

  const clearAndReturn = () =>
    res.send(`
      <script>
        localStorage.removeItem("access_token");
        localStorage.removeItem("id_token");
        localStorage.removeItem("refresh_token");
        localStorage.removeItem("helio.stepUpTicket");
        localStorage.removeItem("helio.stepUpTicketExp");
        localStorage.removeItem("helio.pendingHighRiskTransfer");
        localStorage.removeItem("helio.approvalTicket");
        window.location.href = "/";
      </script>
    `);

  const claims = decodeJwtClaims(idTokenHint);
  if (claims?.sub) {
    recordAuthLogoutBySub(claims.sub).catch(() => {});
  }

  if (!logoutEndpoint) {
    return clearAndReturn();
  }

  const query = new URLSearchParams({
    post_logout_redirect_uri: postLogoutRedirectUri
  });

  if (idTokenHint) {
    query.set("id_token_hint", idTokenHint);
  }

  const logoutUrl = `${logoutEndpoint}?${query.toString()}`;
  return res.redirect(logoutUrl);
});

router.get("/logout/callback", (req, res) => {
  return res.send(`
    <script>
      localStorage.removeItem("access_token");
      localStorage.removeItem("id_token");
      localStorage.removeItem("refresh_token");
      localStorage.removeItem("helio.stepUpTicket");
      localStorage.removeItem("helio.stepUpTicketExp");
      localStorage.removeItem("helio.pendingHighRiskTransfer");
      localStorage.removeItem("helio.approvalTicket");
      window.location.href = "/";
    </script>
  `);
});

router.post("/refresh", async (req, res) => {
  const refreshToken = String(req.body?.refreshToken || "").trim();
  if (!refreshToken) {
    return res.status(400).json({ error: "refreshToken is required" });
  }

  try {
    const tokenData = await refreshTokenGrant(refreshToken);
    return res.json({
      access_token: tokenData.access_token || "",
      id_token: tokenData.id_token || "",
      refresh_token: tokenData.refresh_token || refreshToken,
      expires_in: tokenData.expires_in || null
    });
  } catch (error) {
    const message = error?.response?.data?.error_description || error?.message || "Token refresh failed";
    return res.status(401).json({ error: message });
  }
});

export default router;
