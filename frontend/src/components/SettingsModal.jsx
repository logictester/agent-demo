import { useState, useEffect } from "react";
import { useApp } from "../context/AppContext";
import { formatCurrency, formatRunTimestamp } from "../utils/format";
import * as api from "../api/client";
import AutomationRulesList from "./AutomationRulesList";
import "./SettingsModal.css";

export default function SettingsModal({ open, onClose }) {
  const {
    delegation,
    setDelegation,
    canManageAutomations,
    automationRules,
    loadAutomationRules,
    loadPendingApprovals,
    loadDelegationStatus,
    loadAuthorizationEvents,
    openConfirmModal,
  } = useApp();

  /* ── Delegation form state ── */
  const [selectedOps, setSelectedOps] = useState([]);
  const [purposes, setPurposes] = useState(["general_assistance"]);
  const [expiry, setExpiry] = useState("");
  const [maxTransfer, setMaxTransfer] = useState("");
  const [delegationMsg, setDelegationMsg] = useState("");

  /* ── Automation form state ── */
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [ruleName, setRuleName] = useState("Balance based rule");
  const [transferAmount, setTransferAmount] = useState("");
  const [minBalance, setMinBalance] = useState("");
  const [mode, setMode] = useState("scheduled");
  const [sourceAccount, setSourceAccount] = useState("available");
  const [destAccount, setDestAccount] = useState("savings");
  const [scheduleType, setScheduleType] = useState("hourly");
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [timesPerWeek, setTimesPerWeek] = useState(3);
  const [specificDates, setSpecificDates] = useState("");
  const [autoStatus, setAutoStatus] = useState("");

  /* Sync delegation state to form when modal opens */
  useEffect(() => {
    if (!open) return;
    setSelectedOps(delegation.delegatedOperations);
    setPurposes(
      Array.isArray(delegation.constraints?.purposes)
        ? delegation.constraints.purposes
        : ["general_assistance"]
    );
    const raw = String(delegation.constraints?.expiresAt || "").trim();
    if (raw) {
      const d = new Date(raw);
      setExpiry(Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16) : "");
    } else {
      setExpiry("");
    }
    setMaxTransfer(
      delegation.constraints?.maxTransferAmount == null ||
        delegation.constraints?.maxTransferAmount === ""
        ? ""
        : String(delegation.constraints.maxTransferAmount)
    );
    setDelegationMsg("");
    loadPendingApprovals();
  }, [open, delegation.delegatedOperations, delegation.constraints]); // eslint-disable-line

  function toggleOp(key) {
    setSelectedOps((ops) =>
      ops.includes(key) ? ops.filter((o) => o !== key) : [...ops, key]
    );
  }

  async function completeIdv() {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setDelegationMsg("Please sign in before starting IDV.");
      return;
    }
    try {
      const data = await api.startIdv("/");
      if (!data.redirectUrl) throw new Error("IDV start URL was not provided.");
      window.location.href = data.redirectUrl;
    } catch (err) {
      setDelegationMsg(`IDV start error: ${err.message}`);
    }
  }

  async function saveDelegation() {
    const normalizedPurposes = purposes.length ? purposes : ["general_assistance"];
    const constraints = {
      purpose: normalizedPurposes[0],
      purposes: normalizedPurposes,
      expiresAt: expiry ? new Date(expiry).toISOString() : null,
      maxTransferAmount:
        maxTransfer && Number.isFinite(Number(maxTransfer)) && Number(maxTransfer) > 0
          ? Number(maxTransfer)
          : null,
    };
    try {
      const data = await api.saveDelegationGrants(selectedOps, constraints);
      setDelegation((d) => ({
        ...d,
        idvVerified: Boolean(data.idvVerified),
        idvVerifiedAt: data.idvVerifiedAt || null,
        delegatedOperations: Array.isArray(data.delegatedOperations)
          ? data.delegatedOperations
          : [],
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
      setDelegationMsg("Delegation updated successfully.");
      await loadPendingApprovals();
      await loadAuthorizationEvents();
      await loadAutomationRules();
      setTimeout(() => setDelegationMsg(""), 2500);
    } catch (err) {
      setDelegationMsg(`Delegation error: ${err.message}`);
    }
  }

  async function approvePending(approvalId) {
    try {
      await api.approveOperation(approvalId);
      setDelegationMsg("Approval submitted. Re-run the operation prompt to execute.");
      await loadPendingApprovals();
      await loadAuthorizationEvents();
    } catch (err) {
      setDelegationMsg(`Approval error: ${err.message}`);
    }
  }

  /* ── Automation form ── */
  function editRule(rule) {
    setEditingRuleId(rule.id);
    setRuleName(rule.name || "Balance based rule");
    setTransferAmount(String(rule.transferAmount ?? ""));
    setMinBalance(String(rule.minAvailableBalance ?? ""));
    setMode(rule.mode || "scheduled");
    setSourceAccount(rule.sourceAccount || "available");
    setDestAccount(rule.destinationAccount || "savings");
    setScheduleType(rule.scheduleType || "hourly");
    setIntervalMinutes(rule.scheduleConfig?.intervalMinutes || rule.intervalMinutes || 1440);
    setTimesPerWeek(rule.scheduleConfig?.timesPerWeek || 3);
    setSpecificDates(
      Array.isArray(rule.scheduleConfig?.dates) ? rule.scheduleConfig.dates.join(", ") : ""
    );
    setAutoStatus(`Editing rule: ${rule.name}`);
  }

  function cancelEdit() {
    setEditingRuleId(null);
    setRuleName("Balance based rule");
    setTransferAmount("");
    setMinBalance("");
    setAutoStatus("Edit cancelled.");
  }

  function buildSchedulePayload() {
    if (scheduleType === "weekly_n_times")
      return { scheduleType, scheduleConfig: { timesPerWeek: Number(timesPerWeek || 1) } };
    if (scheduleType === "specific_dates") {
      const dates = specificDates.split(",").map((s) => s.trim()).filter(Boolean);
      return { scheduleType, scheduleConfig: { dates } };
    }
    if (scheduleType === "custom_interval")
      return { scheduleType, scheduleConfig: { intervalMinutes: Number(intervalMinutes || 1440) } };
    return { scheduleType, scheduleConfig: {} };
  }

  async function saveRule() {
    if (!canManageAutomations()) {
      setAutoStatus("Please delegate 'Manage automations' first.");
      return;
    }
    const body = {
      name: ruleName || "Balance based rule",
      transferAmount: Number(transferAmount),
      minAvailableBalance: Number(minBalance),
      mode,
      sourceAccount,
      destinationAccount: destAccount,
      enabled: true,
      ...buildSchedulePayload(),
    };
    if (scheduleType === "custom_interval") {
      body.intervalMinutes = Number(intervalMinutes || 1440);
    }
    try {
      const editing = Boolean(editingRuleId);
      if (editing) {
        await api.updateAutomationRule(editingRuleId, body);
      } else {
        await api.createAutomationRule(body);
      }
      setAutoStatus(editing ? "Automation rule updated." : "Automation rule saved.");
      setEditingRuleId(null);
      setRuleName("Balance based rule");
      setTransferAmount("");
      setMinBalance("");
      await loadAutomationRules();
    } catch (err) {
      setAutoStatus(`Save error: ${err.message}`);
    }
  }

  async function deleteRule(ruleId) {
    if (!canManageAutomations()) {
      setAutoStatus("Please delegate 'Manage automations' first.");
      return;
    }
    const target = automationRules.find((r) => r.id === ruleId);
    const confirmed = await openConfirmModal({
      title: "Delete Rule",
      message: `Delete ${target?.name || "this rule"}? This action cannot be undone.`,
    });
    if (!confirmed) {
      setAutoStatus("Delete cancelled.");
      return;
    }
    try {
      await api.deleteAutomationRule(ruleId);
      if (editingRuleId === ruleId) cancelEdit();
      setAutoStatus("Automation rule deleted.");
      await loadAutomationRules();
    } catch (err) {
      setAutoStatus(`Delete error: ${err.message}`);
    }
  }

  if (!open) return null;

  const isAutomationEnabled = canManageAutomations();
  const purposeOptions = delegation.purposeOptions.length
    ? delegation.purposeOptions
    : [{ key: "general_assistance", label: "General assistance" }];

  /* delegation status text */
  const token = localStorage.getItem("access_token");
  let statusText;
  if (!token) {
    statusText = "Sign in to configure delegation.";
  } else if (!delegation.idvVerified) {
    statusText = "IDV not completed. Complete IDV before selecting delegation options.";
  } else {
    const opNames = delegation.delegatedOperations
      .map((k) => delegation.options.find((o) => o.key === k)?.label || k)
      .join(", ") || "None selected";
    const purpose = (delegation.constraints?.purposes || []).join(", ") || "general_assistance";
    const exp = delegation.constraints?.expiresAt
      ? formatRunTimestamp(delegation.constraints.expiresAt)
      : "none";
    const max =
      delegation.constraints?.maxTransferAmount != null && delegation.constraints?.maxTransferAmount !== ""
        ? formatCurrency(Number(delegation.constraints.maxTransferAmount))
        : "none";
    statusText = `Delegated operations: ${opNames}. Purpose: ${purpose}. Expires: ${exp}. Max transfer: ${max}.`;
  }

  return (
    <section className="settings-page" onClick={onClose}>
      <div className="settings-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="settings-card">
          <div className="settings-header">
            <h2 className="menu-title" style={{ margin: 0 }}>
              User Settings
            </h2>
            <button className="btn btn-cancel" onClick={onClose}>
              <span className="material-symbols-outlined">close</span>Close
            </button>
          </div>

          <div className="delegation-note">
            {delegation.idvVerified
              ? "IDV completed, you can choose what operations the agent is allowed to perform on your behalf."
              : "Complete IDV first, then choose what operations the agent is allowed to perform on your behalf."}
          </div>

          <div className="settings-grid">
            {/* ── Delegation ── */}
            <div className="settings-card">
              <h3 className="menu-title" style={{ margin: "0 0 8px" }}>
                Delegation
              </h3>

              {token && !delegation.idvVerified && (
                <div className="delegation-actions">
                  <button className="btn btn-login" onClick={completeIdv}>
                    <span className="material-symbols-outlined">verified_user</span>
                    Complete IDV
                  </button>
                </div>
              )}

              <div className="automation-grid" style={{ marginBottom: 8 }}>
                <select
                  multiple
                  value={purposes}
                  disabled={!delegation.idvVerified}
                  onChange={(e) => {
                    const vals = Array.from(e.target.selectedOptions, (o) => o.value);
                    setPurposes(vals.length ? vals : ["general_assistance"]);
                  }}
                >
                  {purposeOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="datetime-local"
                  value={expiry}
                  disabled={!delegation.idvVerified}
                  onChange={(e) => setExpiry(e.target.value)}
                  placeholder="Delegation expiry"
                />
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={maxTransfer}
                  disabled={!delegation.idvVerified}
                  onChange={(e) => setMaxTransfer(e.target.value)}
                  placeholder="Max transfer amount"
                />
              </div>

              <div className="delegation-options">
                {delegation.options.map((option) => (
                  <label className="delegation-option" key={option.key}>
                    <input
                      type="checkbox"
                      checked={selectedOps.includes(option.key)}
                      disabled={!delegation.idvVerified}
                      onChange={() => toggleOp(option.key)}
                    />
                    <div>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </div>
                  </label>
                ))}
              </div>

              {/* pending approvals */}
              <div className="delegation-options">
                {delegation.pendingApprovals.length === 0 ? (
                  <div className="delegation-status">No pending high-risk approvals.</div>
                ) : (
                  <>
                    <div className="delegation-status">Pending approvals</div>
                    {delegation.pendingApprovals.map((a) => (
                      <div className="delegation-option" key={a.id}>
                        <div>
                          <strong>High-risk transfer approval</strong>
                          <small>
                            {formatCurrency(Number(a?.payload?.amount || 0))} to{" "}
                            {String(a?.payload?.toAccount || "target")} | expires{" "}
                            {formatRunTimestamp(a.expiresAt)}
                          </small>
                        </div>
                        <button className="btn btn-save" onClick={() => approvePending(a.id)}>
                          <span className="material-symbols-outlined">check_circle</span>Approve
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="delegation-status">
                {delegationMsg || statusText}
              </div>

              <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                <button className="btn btn-save" onClick={saveDelegation}>
                  <span className="material-symbols-outlined">save</span>Save Delegation
                </button>
              </div>
            </div>

            {/* ── Scheduler Configuration ── */}
            <div className="settings-card">
              <div className="settings-scheduler-header">
                <h3 className="menu-title" style={{ margin: 0 }}>
                  Scheduler Configuration
                </h3>
              </div>

              <div className="automation-grid">
                <input
                  type="text"
                  value={ruleName}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="Rule name"
                />
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={transferAmount}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setTransferAmount(e.target.value)}
                  placeholder="Transfer amount"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={minBalance}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setMinBalance(e.target.value)}
                  placeholder="Min available balance"
                />
                <select
                  value={mode}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="scheduled">Scheduled automation</option>
                  <option value="on_demand">On-demand rule</option>
                </select>
                <select
                  value={sourceAccount}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setSourceAccount(e.target.value)}
                >
                  <option value="available">From available</option>
                  <option value="savings">From savings</option>
                </select>
                <select
                  value={destAccount}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setDestAccount(e.target.value)}
                >
                  <option value="savings">To savings</option>
                  <option value="available">To available</option>
                </select>
                <select
                  value={scheduleType}
                  disabled={!isAutomationEnabled}
                  onChange={(e) => setScheduleType(e.target.value)}
                >
                  <option value="hourly">Every hour</option>
                  <option value="daily">Every day</option>
                  <option value="weekly_n_times">N times per week</option>
                  <option value="custom_interval">Custom interval</option>
                  <option value="specific_dates">Specific dates</option>
                </select>

                {scheduleType === "custom_interval" && (
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={intervalMinutes}
                    disabled={!isAutomationEnabled}
                    onChange={(e) => setIntervalMinutes(e.target.value)}
                    placeholder="Interval minutes"
                  />
                )}
                {scheduleType === "weekly_n_times" && (
                  <input
                    type="number"
                    min="1"
                    max="7"
                    step="1"
                    value={timesPerWeek}
                    disabled={!isAutomationEnabled}
                    onChange={(e) => setTimesPerWeek(e.target.value)}
                    placeholder="Times per week"
                  />
                )}
                {scheduleType === "specific_dates" && (
                  <input
                    type="text"
                    value={specificDates}
                    disabled={!isAutomationEnabled}
                    onChange={(e) => setSpecificDates(e.target.value)}
                    placeholder="Specific dates (comma-separated ISO datetimes)"
                    style={{ gridColumn: "1 / -1" }}
                  />
                )}
              </div>

              <div className="automation-actions">
                <button
                  className="btn btn-save"
                  disabled={!isAutomationEnabled}
                  onClick={saveRule}
                >
                  <span className="material-symbols-outlined">
                    {editingRuleId ? "edit" : "save"}
                  </span>
                  {editingRuleId ? "Update Rule" : "Save Rule"}
                </button>
                {editingRuleId && (
                  <button className="btn btn-cancel" onClick={cancelEdit}>
                    <span className="material-symbols-outlined">cancel</span>Cancel Edit
                  </button>
                )}
              </div>

              {autoStatus && (
                <div className="automation-status">{autoStatus}</div>
              )}

              <AutomationRulesList
                showEditButton
                onEditRule={editRule}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
