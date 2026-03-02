import { useState } from "react";
import { useApp } from "../context/AppContext";
import { formatRunTimestamp } from "../utils/format";
import * as api from "../api/client";
import "./AutomationRulesList.css";

export default function AutomationRulesList({ showEditButton, onEditRule }) {
  const {
    automationRules,
    canManageAutomations,
    loadAutomationRules,
    loadFinancialState,
  } = useApp();

  const [enabledOnly, setEnabledOnly] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [status, setStatus] = useState("");
  const [runDetails, setRunDetails] = useState(null);

  const filtered = enabledOnly
    ? automationRules.filter((r) => r.enabled)
    : automationRules;

  async function toggleEnabled(ruleId, enabled) {
    if (!canManageAutomations()) {
      setStatus("Please delegate 'Manage automations' first.");
      return;
    }
    try {
      await api.updateAutomationRule(ruleId, { enabled });
      setStatus(`Rule ${enabled ? "enabled" : "disabled"}.`);
      setRunDetails(null);
      await loadAutomationRules();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      await loadAutomationRules();
    }
  }

  async function runRule(rule) {
    if (!canManageAutomations() || runningId) return;
    try {
      setRunningId(rule.id);
      setStatus(`Running "${rule.name}" via AI engine...`);
      setRunDetails({ thinking: true, ruleName: rule.name });

      const data = await api.runAutomationRule(rule.id);
      const result = data?.result || {};
      setStatus(`Run-now result: ${result.status || "unknown"}.`);
      setRunDetails(result);
      await loadFinancialState();
      await loadAutomationRules();
    } catch (err) {
      setStatus(`Run error: ${err.message}`);
      setRunDetails(null);
    } finally {
      setRunningId(null);
    }
  }

  function scheduleText(rule) {
    if (rule.mode === "on_demand") return "On demand";
    if (rule.scheduleType === "hourly") return "Every hour";
    if (rule.scheduleType === "daily") return "Every day";
    if (rule.scheduleType === "weekly_n_times")
      return `${Number(rule.scheduleConfig?.timesPerWeek || 1)} times per week`;
    if (rule.scheduleType === "specific_dates") return "Specific dates";
    return `Every ${rule.intervalMinutes} minutes`;
  }

  return (
    <div className="agent-automation-section">
      <div className="automation-header-row">
        <h3 className="automation-title">AI Automations</h3>
        <div className="rule-toggle-row">
          <span className="rule-toggle-label">Enabled only</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={enabledOnly}
              onChange={(e) => setEnabledOnly(e.target.checked)}
            />
            <span className="slider" />
          </label>
        </div>
      </div>

      {status && <div className="automation-status">{status}</div>}

      {runDetails && (
        <div className="automation-run-details">
          {runDetails.thinking ? (
            <>
              <div className="automation-run-title">Automation execution in progress</div>
              <div className="flow-step"><strong>Status:</strong> thinking</div>
              <div className="flow-step">Rule: {runDetails.ruleName}</div>
              <div className="flow-step">AI engine is evaluating policy and preparing execution.</div>
              <div className="flow-step">Please wait...</div>
            </>
          ) : (
            <>
              <div className="automation-run-title">
                {runDetails.status === "completed"
                  ? "Automation execution details"
                  : "Automation execution failed/skipped"}
              </div>
              <div className="flow-step"><strong>Status:</strong> {runDetails.status || "unknown"}</div>
              {runDetails.operation && (
                <div className="flow-step">
                  <strong>Operation:</strong>{" "}
                  {Number(runDetails.operation.amount || 0).toFixed(2)} from{" "}
                  {runDetails.operation.fromAccount || "available"} to{" "}
                  {runDetails.operation.toAccount || "savings"} (risk:{" "}
                  {runDetails.operation.riskStatus || "Normal"})
                </div>
              )}
              {runDetails.balances && (
                <div className="flow-step">
                  <strong>Balances:</strong> available{" "}
                  {Number(runDetails.balances.availableBalance || 0).toFixed(2)}, savings{" "}
                  {Number(runDetails.balances.savingsBalance || 0).toFixed(2)}
                </div>
              )}
              {runDetails.reason && (
                <div className="flow-step"><strong>Reason:</strong> {runDetails.reason}</div>
              )}
              {runDetails.code && (
                <div className="flow-step"><strong>Code:</strong> {runDetails.code}</div>
              )}
              <div className="flow-step">
                source: {runDetails.source || "automation"} | model:{" "}
                {runDetails.model || "deterministic-rule-engine"}
              </div>
              <div className="flow-step">
                <strong>Source of decision:</strong>{" "}
                {runDetails.decisionSource || "automation-rule-engine"}
              </div>
              {Array.isArray(runDetails.decisionFlow) && runDetails.decisionFlow.length > 0 && (
                <>
                  <div className="flow-title">How it reached this</div>
                  {runDetails.decisionFlow.map((step, i) => (
                    <div className="flow-step" key={i}>
                      {i + 1}. {String(step || "")}
                    </div>
                  ))}
                </>
              )}
              <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                <button className="btn btn-cancel" onClick={() => setRunDetails(null)}>
                  <span className="material-symbols-outlined">close</span>Clear
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="automation-rules">
        {!filtered.length ? (
          <div className="automation-rule-item">No automation rules saved.</div>
        ) : (
          filtered.map((rule) => {
            const isRunning = runningId === rule.id;
            return (
              <div className="automation-rule-item" key={rule.id}>
                <div><strong>{rule.name}</strong></div>
                <div>
                  Transfer ${Number(rule.transferAmount).toFixed(2)} when balance
                  &ge; ${Number(rule.minAvailableBalance).toFixed(2)}
                </div>
                <div>{scheduleText(rule)}</div>
                <div className="rule-toggle-row">
                  <span className="rule-toggle-label">
                    Enabled: {rule.enabled ? "On" : "Off"}
                  </span>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => toggleEnabled(rule.id, e.target.checked)}
                    />
                    <span className="slider" />
                  </label>
                </div>
                <div>
                  Next run: {formatRunTimestamp(rule.nextRunAt)} | Last run:{" "}
                  {formatRunTimestamp(rule.lastRunAt)}
                </div>
                <div className="rule-actions">
                  {showEditButton && (
                    <button
                      className="btn btn-edit"
                      onClick={() => onEditRule?.(rule)}
                    >
                      <span className="material-symbols-outlined">edit</span>Edit
                    </button>
                  )}
                  <button
                    className="btn btn-save"
                    disabled={isRunning || !rule.enabled}
                    onClick={() => runRule(rule)}
                  >
                    <span className="material-symbols-outlined">
                      {isRunning ? "hourglass_top" : "play_arrow"}
                    </span>
                    {isRunning ? "Thinking..." : "Run"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
