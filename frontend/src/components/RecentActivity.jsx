import { useState } from "react";
import { useApp } from "../context/AppContext";
import { formatCurrency, formatShortTimestamp } from "../utils/format";
import { getOperationSource, getAutomationExecutionType } from "../context/AppContext";
import "./RecentActivity.css";

const PAGE_SIZE = 6;

export default function RecentActivity() {
  const { transactions, loadFinancialState, isAuthenticated } = useApp();
  const [page, setPage] = useState(1);

  const items = Array.isArray(transactions) ? transactions : [];
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const pageItems = items.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  return (
    <aside className="card side-card">
      <div className="side-card-header">
        <h3>Recent Activity</h3>
        {isAuthenticated && (
          <button className="btn btn-edit" onClick={loadFinancialState}>
            <span className="material-symbols-outlined">refresh</span>Refresh
          </button>
        )}
      </div>

      <div className="tx">
        {!isAuthenticated ? (
          <div className="tx-item tx-auth-note">
            <span>Please authenticate to view recent activity.</span>
            <span></span>
          </div>
        ) : !pageItems.length ? (
          <div className="tx-item">
            <span>No activity yet</span>
            <span></span>
          </div>
        ) : (
          pageItems.map((tx, i) => {
            const amount = Number(tx.amount);
            const isOutflow =
              String(tx.fromAccount || "").toLowerCase() === "available";
            const signed = Number.isFinite(amount)
              ? `${isOutflow ? "-" : "+"}${formatCurrency(amount)}`
              : "";
            const label = tx.description || tx.kind || "Transaction";
            const time = formatShortTimestamp(tx.timestamp);
            const source = getOperationSource(tx);
            const automationType = getAutomationExecutionType(tx);
            const sourceLabel =
              source === "automation"
                ? `Automation${automationType ? ` \u2022 ${automationType === "scheduled" ? "Scheduled" : "On-demand"}` : ""}`
                : "Prompt";

            return (
              <div className="tx-item" key={tx.id || i}>
                <span>
                  {label}
                  {time && (
                    <small className="tx-time"> ({time})</small>
                  )}
                  {" "}
                  <small className="tx-source">[{sourceLabel}]</small>
                </span>
                <span>{signed}</span>
              </div>
            );
          })
        )}
      </div>

      {isAuthenticated && (
        <div className="tx-pagination">
          <button
            className="btn btn-edit"
            disabled={currentPage <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <span className="material-symbols-outlined">chevron_left</span>Prev
          </button>
          <span className="tx-page-label">
            Page {currentPage} of {totalPages}
          </span>
          <button
            className="btn btn-edit"
            disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <span className="material-symbols-outlined">chevron_right</span>Next
          </button>
        </div>
      )}
    </aside>
  );
}
