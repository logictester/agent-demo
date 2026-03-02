import { useApp } from "../context/AppContext";

export default function ConfirmModal() {
  const { confirmModal, resolveConfirm } = useApp();

  if (!confirmModal) return null;

  return (
    <div className="modal-backdrop" onClick={() => resolveConfirm(false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>{confirmModal.title || "Confirm Action"}</h3>
        <p className="modal-message">{confirmModal.message || "Are you sure?"}</p>
        <div className="modal-actions">
          <button className="btn btn-cancel" onClick={() => resolveConfirm(false)}>
            <span className="material-symbols-outlined">close</span>Cancel
          </button>
          <button className="btn btn-delete" onClick={() => resolveConfirm(true)}>
            <span className="material-symbols-outlined">check</span>Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
