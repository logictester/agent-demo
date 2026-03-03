import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import * as api from "../api/client";

const STORAGE_KEYS = {
  lastMessage: "helio.lastMessage",
  questionHistory: "helio.questionHistory",
  lastResponse: "helio.lastResponse",
  pendingHighRiskTransfer: "helio.pendingHighRiskTransfer",
  stepUpTicket: "helio.stepUpTicket",
  stepUpTicketExp: "helio.stepUpTicketExp",
  approvalTicket: "helio.approvalTicket",
};

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

function decodeJwtClaims(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function getValidStepUpTicket() {
  const ticket = localStorage.getItem(STORAGE_KEYS.stepUpTicket);
  const exp = Number(localStorage.getItem(STORAGE_KEYS.stepUpTicketExp));
  const now = Math.floor(Date.now() / 1000);
  if (!ticket || !Number.isFinite(exp) || now >= exp) {
    localStorage.removeItem(STORAGE_KEYS.stepUpTicket);
    localStorage.removeItem(STORAGE_KEYS.stepUpTicketExp);
    return "";
  }
  return ticket;
}

function getSessionSecondsRemaining() {
  const idToken = localStorage.getItem("id_token");
  const claims = decodeJwtClaims(idToken);
  const exp = Number(claims?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp - Math.floor(Date.now() / 1000);
}

function resolveDisplayName() {
  const idToken = localStorage.getItem("id_token");
  const claims = decodeJwtClaims(idToken);
  if (!claims) return "Guest User";
  const fullName = claims?.fullName?.formatted;
  if (fullName && String(fullName).trim()) return String(fullName).trim();
  const given = claims?.fullName?.givenName || claims?.given_name || "";
  const family = claims?.fullName?.familyName || claims?.family_name || "";
  const composed = `${given} ${family}`.trim();
  if (composed) return composed;
  return claims?.email || claims?.sub || "Guest User";
}

function readQuestionHistory() {
  const raw = localStorage.getItem(STORAGE_KEYS.questionHistory);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function getOperationSource(tx) {
  const metadata =
    tx?.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
  const source = String(metadata.operationSource || "").toLowerCase();
  if (source === "automation") return "automation";
  if (source === "prompt") return "prompt";
  if (metadata.automationRuleId || metadata.automated) return "automation";
  return "prompt";
}

function getAutomationExecutionType(tx) {
  const metadata =
    tx?.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
  const mode = String(metadata.automationExecutionType || "").toLowerCase();
  if (mode === "scheduled" || mode === "on_demand") return mode;
  if (metadata.automated)
    return metadata.scheduled ? "scheduled" : "on_demand";
  return null;
}

function consumeAuthRedirectHash() {
  const hash = String(window.location.hash || "").replace(/^#/, "").trim();
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const shouldLogout = params.get("logout") === "1";
  const accessToken = params.get("access_token");
  const idToken = params.get("id_token");
  const refreshToken = params.get("refresh_token");
  const stepUpTicket = params.get("stepup_ticket");
  const stepUpExp = params.get("stepup_exp");
  const hasAuthPayload = Boolean(accessToken || idToken || refreshToken || stepUpTicket || shouldLogout);

  if (!hasAuthPayload) return false;

  if (shouldLogout) {
    localStorage.removeItem("access_token");
    localStorage.removeItem("id_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem(STORAGE_KEYS.stepUpTicket);
    localStorage.removeItem(STORAGE_KEYS.stepUpTicketExp);
    localStorage.removeItem(STORAGE_KEYS.pendingHighRiskTransfer);
    localStorage.removeItem(STORAGE_KEYS.approvalTicket);
  } else {
    if (accessToken) localStorage.setItem("access_token", accessToken);
    if (idToken) localStorage.setItem("id_token", idToken);
    if (refreshToken) localStorage.setItem("refresh_token", refreshToken);
    if (stepUpTicket && stepUpExp) {
      localStorage.setItem(STORAGE_KEYS.stepUpTicket, stepUpTicket);
      localStorage.setItem(STORAGE_KEYS.stepUpTicketExp, stepUpExp);
    }
  }

  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
  return true;
}

export { STORAGE_KEYS, decodeJwtClaims, getValidStepUpTicket, getSessionSecondsRemaining, resolveDisplayName, readQuestionHistory, getOperationSource, getAutomationExecutionType };

export function AppProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(
    Boolean(localStorage.getItem("access_token"))
  );

  const [account, setAccount] = useState({
    availableBalance: 24982.14,
    savingsBalance: 7410.0,
    riskStatus: "Normal",
    questionsAsked: 0,
    questionsAnswered: 0,
    operationsPerformed: 0,
  });

  const [transactions, setTransactions] = useState([]);
  const [authEvents, setAuthEvents] = useState([]);

  const [delegation, setDelegation] = useState({
    options: [],
    purposeOptions: [],
    idvVerified: false,
    idvVerifiedAt: null,
    delegatedOperations: [],
    constraints: {
      purpose: "general_assistance",
      purposes: ["general_assistance"],
      expiresAt: "",
      maxTransferAmount: "",
    },
    pendingApprovals: [],
  });

  const [automationRules, setAutomationRules] = useState([]);
  const [sessionWarningSeconds, setSessionWarningSeconds] = useState(120);
  const [questionHistory, setQuestionHistory] = useState(readQuestionHistory);

  /* ── Confirm modal ── */
  const [confirmModal, setConfirmModal] = useState(null);
  const confirmResolverRef = useRef(null);

  const openConfirmModal = useCallback(({ title, message }) => {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmModal({ title, message });
    });
  }, []);

  const resolveConfirm = useCallback((confirmed) => {
    setConfirmModal(null);
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    if (resolver) resolver(Boolean(confirmed));
  }, []);

  /* ── Helper: can manage automations ── */
  const canManageAutomations = useCallback(() => {
    return Boolean(
      delegation.idvVerified &&
        delegation.delegatedOperations.includes("manage_automations")
    );
  }, [delegation.idvVerified, delegation.delegatedOperations]);

  /* ── Data loading ── */
  const loadFinancialState = useCallback(async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setAccount((a) => ({
        ...a,
        questionsAsked: 0,
        questionsAnswered: 0,
        operationsPerformed: 0,
      }));
      setTransactions([]);
      setAuthEvents([]);
      return;
    }
    try {
      const data = await api.getAgentState();
      if (data.balances) {
        setAccount((a) => ({
          ...a,
          availableBalance: Number(data.balances.availableBalance) || a.availableBalance,
          savingsBalance: Number(data.balances.savingsBalance) || a.savingsBalance,
        }));
      }
      setTransactions(Array.isArray(data.transactionHistory) ? data.transactionHistory : []);
      if (data.interactionStats) {
        setAccount((a) => ({
          ...a,
          questionsAsked: Number(data.interactionStats.questionsAsked) || 0,
          questionsAnswered: Number(data.interactionStats.questionsAnswered) || 0,
          operationsPerformed: Number(data.interactionStats.operationsPerformed) || 0,
        }));
      }
    } catch {
      setTransactions([]);
    }
  }, []);

  const loadAuthorizationEvents = useCallback(async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setAuthEvents([]);
      return;
    }
    try {
      const data = await api.getAuthorizationEvents();
      setAuthEvents(Array.isArray(data.events) ? data.events : []);
    } catch {
      setAuthEvents([]);
    }
  }, []);

  const loadDelegationOptions = useCallback(async () => {
    try {
      const data = await api.getDelegationOptions();
      setDelegation((d) => ({
        ...d,
        options: Array.isArray(data.options) ? data.options : [],
        purposeOptions: Array.isArray(data.purposeOptions) ? data.purposeOptions : [],
      }));
    } catch {
      /* keep defaults */
    }
  }, []);

  const loadDelegationStatus = useCallback(async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setDelegation((d) => ({
        ...d,
        idvVerified: false,
        idvVerifiedAt: null,
        delegatedOperations: [],
        constraints: { purpose: "general_assistance", purposes: ["general_assistance"], expiresAt: "", maxTransferAmount: "" },
        pendingApprovals: [],
      }));
      return;
    }
    try {
      const data = await api.getDelegationStatus();
      setDelegation((d) => ({
        ...d,
        idvVerified: Boolean(data.idvVerified),
        idvVerifiedAt: data.idvVerifiedAt || null,
        delegatedOperations: Array.isArray(data.delegatedOperations) ? data.delegatedOperations : [],
        constraints: data.constraints && typeof data.constraints === "object"
          ? {
              purpose: data.constraints.purpose || "general_assistance",
              purposes: Array.isArray(data.constraints.purposes) && data.constraints.purposes.length
                ? data.constraints.purposes
                : [data.constraints.purpose || "general_assistance"],
              expiresAt: data.constraints.expiresAt || "",
              maxTransferAmount: data.constraints.maxTransferAmount == null ? "" : Number(data.constraints.maxTransferAmount),
            }
          : d.constraints,
      }));
    } catch {
      /* keep current */
    }
  }, []);

  const loadPendingApprovals = useCallback(async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setDelegation((d) => ({ ...d, pendingApprovals: [] }));
      return;
    }
    try {
      const data = await api.getPendingApprovals();
      setDelegation((d) => ({
        ...d,
        pendingApprovals: Array.isArray(data.approvals) ? data.approvals : [],
      }));
    } catch {
      setDelegation((d) => ({ ...d, pendingApprovals: [] }));
    }
  }, []);

  const loadAutomationRules = useCallback(async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setAutomationRules([]);
      return;
    }
    try {
      const data = await api.getAutomationRules();
      setAutomationRules(Array.isArray(data.rules) ? data.rules : []);
    } catch {
      setAutomationRules([]);
    }
  }, []);

  const storeQuestionHistory = useCallback((question) => {
    const normalized = String(question || "").trim();
    if (!normalized) return;
    setQuestionHistory((prev) => {
      const next = [normalized, ...prev.filter((q) => q !== normalized)].slice(0, 10);
      localStorage.setItem(STORAGE_KEYS.questionHistory, JSON.stringify(next));
      return next;
    });
  }, []);

  /* ── Initial load ── */
  useEffect(() => {
    consumeAuthRedirectHash();
    setIsAuthenticated(Boolean(localStorage.getItem("access_token")));
    loadDelegationOptions();
    loadDelegationStatus().then(() => loadPendingApprovals());
    loadFinancialState();
    loadAutomationRules();
    loadAuthorizationEvents();

    api.getSessionConfig().then((data) => {
      const val = Number(data.sessionWarningSeconds);
      if (Number.isFinite(val) && val > 0) setSessionWarningSeconds(Math.floor(val));
    }).catch(() => {});

    // handle IDV return status
    const url = new URL(window.location.href);
    const idvStatus = (url.searchParams.get("idv_status") || "").toLowerCase();
    if (idvStatus) {
      url.searchParams.delete("idv_status");
      window.history.replaceState({}, document.title, url.pathname + url.search);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    account, setAccount,
    transactions, setTransactions,
    authEvents, setAuthEvents,
    delegation, setDelegation,
    automationRules, setAutomationRules,
    sessionWarningSeconds,
    questionHistory, storeQuestionHistory,
    confirmModal, openConfirmModal, resolveConfirm,
    canManageAutomations,
    loadFinancialState, loadAuthorizationEvents,
    loadDelegationOptions, loadDelegationStatus,
    loadPendingApprovals, loadAutomationRules,
    STORAGE_KEYS,
    isAuthenticated,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
