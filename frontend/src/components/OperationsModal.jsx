import { useState } from "react";
import { useApp, getOperationSource, getAutomationExecutionType } from "../context/AppContext";
import { formatCurrency, formatShortTimestamp } from "../utils/format";
import "./OperationsModal.css";

export default function OperationsModal({ open, onClose }) {
  const { transactions } = useApp();
  const [sourceFilter, setSourceFilter] = useState("all");
  const [automationFilter, setAutomationFilter] = useState("all");

  if (!open) return null;

  const performed = (Array.isArray(transactions) ? transactions : []).filter(
    (tx) => String(tx.kind || "").toLowerCase() === "transfer"
  );

  let items = performed;
  if (sourceFilter !== "all") {
    items = items.filter((tx) => getOperationSource(tx) === sourceFilter);
  }
  if (sourceFilter === "automation" && automationFilter !== "all") {
    items = items.filter(
      (tx) => getAutomationExecutionType(tx) === automationFilter
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: "min(560px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <h3>Performed Operations</h3>

        <div className="operations-filters">
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="all">All sources</option>
            <option value="prompt">Prompt</option>
            <option value="automation">Automation</option>
          </select>
          <select
            value={automationFilter}
            onChange={(e) => setAutomationFilter(e.target.value)}
            disabled={sourceFilter !== "automation"}
          >
            <option value="all">All automation types</option>
            <option value="on_demand">On-demand</option>
            <option value="scheduled">Scheduled</option>
          </select>
          <button className="btn btn-cancel" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>Close
          </button>
        </div>

        <div className="operations-list">
          {!items.length ? (
            <div className="operations-item">
              No performed operations for current filter.
            </div>
          ) : (
            items.map((tx, i) => {
              const amount = Number(tx.amount);
              const metadata =
                tx?.metadata && typeof tx.metadata === "object"
                  ? tx.metadata
                  : {};
              const source = getOperationSource(tx);
              const automationType = getAutomationExecutionType(tx);
              const sourceText =
                source === "automation"
                  ? `Automation${automationType ? ` (${automationType === "scheduled" ? "Scheduled" : "On-demand"})` : ""}`
                  : "Prompt";
              const executedAt = formatShortTimestamp(
                metadata.executionTimestamp || tx.timestamp
              );

              return (
                <div className="operations-item" key={tx.id || i}>
                  <div>
                    <strong>{tx.description || "Transfer operation"}</strong>
                  </div>
                  <div>
                    Amount:{" "}
                    {Number.isFinite(amount) ? formatCurrency(amount) : "-"}
                  </div>
                  <div>
                    From {String(tx.fromAccount || "-")} to{" "}
                    {String(tx.toAccount || "-")}
                  </div>
                  <div>Source: {sourceText}</div>
                  {source === "automation" && (
                    <>
                      <div>Delegated by: {String(metadata.delegatedBy || "-")}</div>
                      <div>
                        Scope:{" "}
                        {Array.isArray(metadata.delegationScope)
                          ? metadata.delegationScope.join(", ")
                          : "-"}
                      </div>
                      <div>Auth context: {String(metadata.authContext || "-")}</div>
                      <div>Auth client: {String(metadata.authClientId || "-")}</div>
                      <div>
                        Auth scopes:{" "}
                        {Array.isArray(metadata.authScopes)
                          ? metadata.authScopes.join(", ")
                          : "-"}
                      </div>
                    </>
                  )}
                  <div>Executed at: {executedAt}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
