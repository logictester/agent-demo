import { useState, useEffect, useCallback } from "react";
import { useApp, getSessionSecondsRemaining } from "../context/AppContext";
import * as api from "../api/client";

export default function SessionModal() {
  const { sessionWarningSeconds, loadFinancialState } = useApp();
  const [mode, setMode] = useState(null); // null | "warning" | "expired"
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const check = useCallback(() => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setMode(null);
      return;
    }
    const remaining = getSessionSecondsRemaining();
    if (remaining == null) {
      setMode(null);
      return;
    }
    if (remaining <= 0) {
      setMode("expired");
      setMessage("Your secure session has expired. Please login again to continue.");
      return;
    }
    if (remaining <= sessionWarningSeconds) {
      setMode("warning");
      setMessage(
        `Your session will expire in about ${Math.max(1, Math.ceil(remaining / 60))} minute(s). Continue your session?`
      );
      return;
    }
    setMode(null);
  }, [sessionWarningSeconds]);

  useEffect(() => {
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, [check]);

  async function refresh() {
    const refreshToken = localStorage.getItem("refresh_token");
    if (!refreshToken) {
      setMode("expired");
      setMessage("Session refresh token is unavailable. Please sign in again.");
      return;
    }
    setRefreshing(true);
    try {
      const data = await api.refreshTokens(refreshToken);
      if (data.access_token) localStorage.setItem("access_token", data.access_token);
      if (data.id_token) localStorage.setItem("id_token", data.id_token);
      if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
      setMode(null);
      loadFinancialState();
    } catch (err) {
      setMode("expired");
      setMessage(`Could not refresh session: ${err.message}`);
    } finally {
      setRefreshing(false);
    }
  }

  function loginAgain() {
    localStorage.removeItem("access_token");
    localStorage.removeItem("id_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem("helio.lastResponse");
    window.location.href = "/auth/login?reauth=1&returnTo=/";
  }

  if (!mode) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h3>{mode === "expired" ? "Session expired" : "Session expiring soon"}</h3>
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          {mode === "warning" && (
            <button className="btn btn-save" disabled={refreshing} onClick={refresh}>
              <span className="material-symbols-outlined">autorenew</span>
              {refreshing ? "Refreshing..." : "Continue session"}
            </button>
          )}
          {mode === "expired" && (
            <button className="btn btn-login" onClick={loginAgain}>
              <span className="material-symbols-outlined">login</span>Login again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
