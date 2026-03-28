function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = localStorage.getItem("access_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: authHeaders(),
    ...options,
    headers: { ...authHeaders(), ...options.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/* ── Auth ── */
export function getSessionConfig() {
  return request("/auth/session-config");
}

export function refreshTokens(refreshToken) {
  return request("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

/* ── Agent ── */
export function sendAgentMessage(message, extraHeaders = {}) {
  return request("/agent", {
    method: "POST",
    headers: extraHeaders,
    body: JSON.stringify({ message }),
  });
}

export function getAgentState() {
  return request("/agent/state");
}

/* ── Delegation ── */
export function getDelegationOptions() {
  return request("/delegation/options");
}

export function getDelegationStatus() {
  return request("/delegation/status");
}

export function startIdv(returnTo = "/") {
  return request("/delegation/idv/start", {
    method: "POST",
    body: JSON.stringify({ returnTo }),
  });
}

export function saveDelegationGrants(operations, constraints) {
  return request("/delegation/grants", {
    method: "POST",
    body: JSON.stringify({ operations, constraints }),
  });
}

export function getPendingApprovals() {
  return request("/delegation/approvals");
}

export function approveOperation(approvalId) {
  return request(
    `/delegation/approvals/${encodeURIComponent(approvalId)}/approve`,
    { method: "POST" }
  );
}

export function getAuthorizationEvents(limit = 60) {
  return request(`/delegation/events?limit=${limit}`);
}

export function sendSlackTestNotification() {
  return request("/delegation/notifications/slack/test", {
    method: "POST",
  });
}

/* ── Automation ── */
export function getAutomationRules() {
  return request("/automation/rules");
}

export function createAutomationRule(body) {
  return request("/automation/rules", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAutomationRule(id, body) {
  return request(`/automation/rules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteAutomationRule(id) {
  return request(`/automation/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function runAutomationRule(id) {
  return request(`/automation/rules/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
}

/* ── Stocks ── */
export function getStockDashboard(extraHeaders = {}) {
  return request("/stocks/dashboard", {
    headers: extraHeaders,
  });
}

export function sendStockAgentMessage(message, extraHeaders = {}) {
  return request("/stocks/agent", {
    method: "POST",
    headers: extraHeaders,
    body: JSON.stringify({ message }),
  });
}
