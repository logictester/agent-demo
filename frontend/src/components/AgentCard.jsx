import { useState, useRef, useEffect } from "react";
import { useApp, STORAGE_KEYS, getValidStepUpTicket } from "../context/AppContext";
import { getSessionSecondsRemaining } from "../context/AppContext";
import * as api from "../api/client";
import AutomationRulesList from "./AutomationRulesList";
import "./AgentCard.css";

export default function AgentCard({ onSessionExpired }) {
  const {
    account, setAccount,
    setTransactions, transactions,
    setAutomationRules,
    loadFinancialState, loadAuthorizationEvents,
    loadAutomationRules, loadPendingApprovals,
    canManageAutomations,
    questionHistory, storeQuestionHistory,
  } = useApp();

  const [message, setMessage] = useState("");
  const [response, setResponse] = useState({
    text: "Response will appear here.",
    isError: false,
    payload: null,
  });
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const resumedPendingRef = useRef(false);
  const externalApprovalHandledRef = useRef("");

  async function send(messageOverride, options = {}) {
    const msg = String(
      messageOverride != null ? messageOverride : message
    ).trim();
    if (!msg) {
      setResponse({ text: "Please enter a message before sending.", isError: true, payload: null });
      return;
    }

    const remaining = getSessionSecondsRemaining();
    if (remaining != null && remaining <= 0) {
      onSessionExpired?.();
      return;
    }

    setResponse({ text: "Thinking...", isError: false, payload: null });
    setSending(true);
    localStorage.setItem(STORAGE_KEYS.lastMessage, msg);
    storeQuestionHistory(msg);

    try {
      const token = localStorage.getItem("access_token");
      const idToken = localStorage.getItem("id_token");
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (idToken) headers["X-Id-Token"] = idToken;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) headers["X-Client-Timezone"] = tz;
      const locale = navigator.language || "";
      if (locale) headers["X-Client-Locale"] = locale;
      const stepUp = getValidStepUpTicket();
      if (stepUp) headers["X-Step-Up-Ticket"] = stepUp;
      const explicitApprovalTicket = String(options.approvalTicket || "").trim();
      const approval = explicitApprovalTicket || localStorage.getItem(STORAGE_KEYS.approvalTicket);
      if (approval) headers["X-Approval-Ticket"] = approval;

      const data = await api.sendAgentMessage(msg, headers);

      if (data.riskStatus) {
        setAccount((a) => ({ ...a, riskStatus: data.riskStatus }));
      }
      if (data.balances) {
        setAccount((a) => ({
          ...a,
          availableBalance: Number(data.balances.availableBalance) || a.availableBalance,
          savingsBalance: Number(data.balances.savingsBalance) || a.savingsBalance,
        }));
      }
      if (data.transactionHistory) {
        setTransactions(Array.isArray(data.transactionHistory) ? data.transactionHistory : []);
      }
      if (Array.isArray(data.automationRules)) {
        setAutomationRules(data.automationRules);
      }
      if (data.interactionStats) {
        setAccount((a) => ({
          ...a,
          questionsAsked: Number(data.interactionStats.questionsAsked) || 0,
          questionsAnswered: Number(data.interactionStats.questionsAnswered) || 0,
          operationsPerformed: Number(data.interactionStats.operationsPerformed) || 0,
        }));
      }

      if (data.transfer && Number(data.transfer.amount) > 100) {
        localStorage.removeItem(STORAGE_KEYS.pendingHighRiskTransfer);
        localStorage.removeItem(STORAGE_KEYS.stepUpTicket);
        localStorage.removeItem(STORAGE_KEYS.stepUpTicketExp);
        localStorage.removeItem(STORAGE_KEYS.approvalTicket);
      }
      if (!data.requiresApproval && data.intent !== "transfer_funds") {
        localStorage.removeItem(STORAGE_KEYS.approvalTicket);
      }
      if (data.requiresApproval && data.approvalTicket) {
        localStorage.setItem(STORAGE_KEYS.approvalTicket, String(data.approvalTicket));
      }

      if (data.intent === "manage_automations") {
        await loadAutomationRules();
      }
      await loadAuthorizationEvents();

      setResponse({ text: data.output || "", isError: false, payload: data });
      setMessage("");
    } catch (error) {
      setResponse({ text: `Error: ${error.message}`, isError: true, payload: null });
      await loadAuthorizationEvents();
      setMessage("");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function clearResponse() {
    setResponse({ text: "Response will appear here.", isError: false, payload: null });
  }

  useEffect(() => {
    let cancelled = false;
    const tryResumePending = () => {
      if (cancelled || resumedPendingRef.current || sending) {
        return;
      }
      const pendingRaw = localStorage.getItem(STORAGE_KEYS.pendingHighRiskTransfer);
      if (!pendingRaw) {
        return;
      }
      const token = localStorage.getItem("access_token");
      const stepUpTicket = getValidStepUpTicket();
      if (!token || !stepUpTicket) {
        return;
      }

      let pendingMessage = "";
      try {
        const pending = JSON.parse(pendingRaw);
        pendingMessage = String(pending?.message || "").trim();
      } catch {
        pendingMessage = "";
      }
      if (!pendingMessage) {
        pendingMessage = String(localStorage.getItem(STORAGE_KEYS.lastMessage) || "").trim();
      }

      localStorage.removeItem(STORAGE_KEYS.pendingHighRiskTransfer);
      resumedPendingRef.current = true;

      if (!pendingMessage) {
        return;
      }

      setResponse({
        text: "Re-authentication completed. Continuing your pending high-risk transfer...",
        isError: false,
        payload: null
      });
      send(pendingMessage);
    };

    tryResumePending();
    const id = setInterval(tryResumePending, 800);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sending]);

  useEffect(() => {
    let cancelled = false;
    const approvalTicket = String(response?.payload?.approvalTicket || "").trim();
    const requiresApproval = Boolean(response?.payload?.requiresApproval);
    if (!approvalTicket || !requiresApproval) {
      return;
    }

    const pollApproval = async () => {
      if (cancelled) {
        return;
      }
      try {
        const data = await api.getApprovalById(approvalTicket);
        const approval = data?.approval || null;
        const status = String(approval?.status || "").trim().toLowerCase();
        const handledKey = `${approvalTicket}:${status}`;
        if (!status || handledKey === externalApprovalHandledRef.current) {
          return;
        }

        if (status === "approved") {
          externalApprovalHandledRef.current = handledKey;
          localStorage.setItem(STORAGE_KEYS.approvalTicket, approvalTicket);
          setResponse((prev) => ({
            ...prev,
            text: "Approval completed in Slack. Continuing your pending transfer..."
          }));
          const lastMsg = localStorage.getItem(STORAGE_KEYS.lastMessage) || message;
          if (lastMsg) {
            send(lastMsg, { approvalTicket });
          }
          return;
        }

        if (status === "denied" || status === "expired") {
          externalApprovalHandledRef.current = handledKey;
          localStorage.removeItem(STORAGE_KEYS.approvalTicket);
          setResponse((prev) => ({
            ...prev,
            isError: status === "denied",
            text:
              status === "denied"
                ? "Approval was denied in Slack. The pending transfer was not executed."
                : "Approval expired before the transfer could continue."
          }));
          await loadPendingApprovals();
        }
      } catch {
        // Keep polling quietly while the approval is pending.
      }
    };

    pollApproval();
    const id = setInterval(pollApproval, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [response, message, loadPendingApprovals]);

  function handleApproveNow(approvalTicket) {
    api.approveOperation(approvalTicket).then(() => {
      localStorage.setItem(STORAGE_KEYS.approvalTicket, String(approvalTicket));
      loadPendingApprovals();
      const lastMsg = localStorage.getItem(STORAGE_KEYS.lastMessage) || message;
      send(lastMsg, { approvalTicket });
    }).catch((err) => {
      setResponse({ text: `Error: ${err.message}`, isError: true, payload: null });
    });
  }

  const payload = response.payload;

  return (
    <section className="card assistant-card">
      <h2>AI Banking Agent</h2>

      <div className="input-row">
        <input
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Try: transfer 50 to savings account"
          disabled={sending}
        />
        <select
          className="history-select"
          value=""
          onChange={(e) => {
            if (e.target.value) setMessage(e.target.value);
          }}
          disabled={!questionHistory.length}
        >
          <option value="">
            {questionHistory.length ? "Recent questions" : "No recent questions"}
          </option>
          {questionHistory.map((q, i) => (
            <option key={i} value={q}>
              {q}
            </option>
          ))}
        </select>
        <button className="btn btn-save" onClick={() => send()} disabled={sending}>
          <span className="material-symbols-outlined">send</span>Send
        </button>
      </div>

      <div className="prompt-hints">
        <strong>Automation Prompt Hints</strong>
        <div>
          &bull; Create: &quot;Schedule a rule to transfer 500 from available to
          savings once a week when balance is above 15000.&quot;
        </div>
        <div>
          &bull; Edit: &quot;Edit my weekly savings rule and change transfer amount
          to 650.&quot;
        </div>
        <div>
          &bull; Adaptive: &quot;If balance goes below 18000, lower transfer to
          200; below 16000 lower to 100.&quot;
        </div>
        <div>
          &bull; Run/List: &quot;Run my weekly savings rule now.&quot; / &quot;List
          my automation rules.&quot;
        </div>
      </div>

      <div className={`response ${response.isError ? "error" : ""}`}>
        {response.text}

        {!response.isError && payload?.source && (
          <div className="response-meta">
            source: {payload.source}
            {payload.model ? ` | model: ${payload.model}` : ""}
          </div>
        )}

        {!response.isError && payload?.riskTier && (
          <div className="response-meta">risk tier: {payload.riskTier}</div>
        )}

        {!response.isError &&
          Array.isArray(payload?.decisionFlow) &&
          payload.decisionFlow.length > 0 && (
            <div className="flow-box">
              <div className="flow-title">How I reached this</div>
              {payload.decisionFlow.map((step, i) => (
                <div className="flow-step" key={i}>
                  {i + 1}. {String(step || "")}
                </div>
              ))}
            </div>
          )}

        {payload?.requiresReauth && (
          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-login"
              onClick={() => {
                const msg =
                  String(localStorage.getItem(STORAGE_KEYS.lastMessage) || "").trim() ||
                  message.trim();
                localStorage.setItem(
                  STORAGE_KEYS.pendingHighRiskTransfer,
                  JSON.stringify({ message: msg, createdAt: Date.now() })
                );
                window.location.href = payload.reauthUrl || "/auth/login";
              }}
            >
              <span className="material-symbols-outlined">lock_reset</span>
              Re-authenticate with OneWelcome
            </button>
          </div>
        )}

        {!response.isError &&
          payload?.requiresApproval &&
          payload?.approvalTicket && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn btn-save"
                onClick={() => handleApproveNow(payload.approvalTicket)}
              >
                <span className="material-symbols-outlined">check_circle</span>
                Approve Now
              </button>
              <button
                className="btn btn-edit"
                onClick={() => {
                  loadPendingApprovals();
                }}
              >
                <span className="material-symbols-outlined">settings</span>
                Open User Settings
              </button>
            </div>
          )}
      </div>

      <div className="response-actions">
        <button className="btn btn-cancel" onClick={clearResponse}>
          <span className="material-symbols-outlined">delete_sweep</span>Clear
          Response
        </button>
      </div>

      <AutomationRulesList />
    </section>
  );
}
