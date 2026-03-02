import { useState, useEffect } from "react";
import { useApp, STORAGE_KEYS, getValidStepUpTicket, getSessionSecondsRemaining } from "./context/AppContext";
import Header from "./components/Header";
import HeroCard from "./components/HeroCard";
import RecentActivity from "./components/RecentActivity";
import AgentCard from "./components/AgentCard";
import AuthorizationEvents from "./components/AuthorizationEvents";
import SettingsModal from "./components/SettingsModal";
import SessionModal from "./components/SessionModal";
import ConfirmModal from "./components/ConfirmModal";
import OperationsModal from "./components/OperationsModal";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);

  /* Handle post-reauth pending transfer on mount */
  useEffect(() => {
    const pendingRaw = localStorage.getItem(STORAGE_KEYS.pendingHighRiskTransfer);
    if (!pendingRaw) return;
    const token = localStorage.getItem("access_token");
    const stepUpTicket = getValidStepUpTicket();
    if (!token || !stepUpTicket) return;
    try {
      const pending = JSON.parse(pendingRaw);
      if (pending?.message) {
        // The AgentCard will handle sending on mount via lastResponse
      }
      localStorage.removeItem(STORAGE_KEYS.pendingHighRiskTransfer);
    } catch {
      localStorage.removeItem(STORAGE_KEYS.pendingHighRiskTransfer);
    }
  }, []);

  function handleSessionExpired() {
    // The SessionModal handles this automatically
  }

  return (
    <>
      <main className="shell">
        <Header onOpenSettings={() => setSettingsOpen(true)} />

        <section className="grid">
          <HeroCard onOpenOperations={() => setOperationsOpen(true)} />
          <RecentActivity />
        </section>

        <AgentCard onSessionExpired={handleSessionExpired} />
        <AuthorizationEvents />
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SessionModal />
      <ConfirmModal />
      <OperationsModal
        open={operationsOpen}
        onClose={() => setOperationsOpen(false)}
      />
    </>
  );
}
