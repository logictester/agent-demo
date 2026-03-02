import { useState } from "react";
import { useApp } from "../context/AppContext";
import { formatCurrency, formatShortTimestamp } from "../utils/format";
import "./AuthorizationEvents.css";

const PAGE_SIZE = 5;

export default function AuthorizationEvents() {
  const { authEvents, loadAuthorizationEvents } = useApp();
  const [page, setPage] = useState(1);

  const items = Array.isArray(authEvents) ? authEvents : [];
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const pageItems = items.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  function categoryLabel(raw) {
    if (raw === "transfer_authorization") return "Transfer authorization";
    if (raw === "out_of_band_approval") return "Out-of-band approval";
    return "Authorization event";
  }

  return (
    <section className="card">
      <div className="auth-events-header">
        <h2 style={{ margin: 0 }}>Authorization Events</h2>
        <button
          className="btn btn-edit"
          onClick={() => loadAuthorizationEvents()}
        >
          <span className="material-symbols-outlined">refresh</span>Refresh
        </button>
      </div>

      <div className="auth-events">
        {!pageItems.length ? (
          <div className="auth-event-item">
            <strong>No authorization events yet</strong>
            <div>Authorize and run operations to populate this panel.</div>
          </div>
        ) : (
          pageItems.map((event, i) => {
            const category = categoryLabel(event.category || "authorization_event");
            const status =
              String(event.status || "unknown").charAt(0).toUpperCase() +
              String(event.status || "unknown").slice(1);
            const source = String(event.source || "authorization-engine");
            const amount = Number(event?.metadata?.amount);
            const amountLabel = Number.isFinite(amount) ? formatCurrency(amount) : null;
            const toAccount = String(event?.metadata?.toAccount || "").trim();
            const reason = String(event.reason || "").trim();
            const time = formatShortTimestamp(event.timestamp);

            const detailParts = [];
            if (amountLabel) detailParts.push(amountLabel);
            if (toAccount) detailParts.push(`to ${toAccount}`);

            return (
              <div className="auth-event-item" key={event.id || i}>
                <strong>
                  {category} &bull; {status}
                </strong>
                {detailParts.length > 0 && (
                  <div>{detailParts.join(" ")}</div>
                )}
                {reason && <div>{reason}</div>}
                <div style={{ fontSize: "0.78rem" }}>
                  source: {source}
                  {time && ` \u2022 ${time}`}
                </div>
              </div>
            );
          })
        )}
      </div>

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
    </section>
  );
}
