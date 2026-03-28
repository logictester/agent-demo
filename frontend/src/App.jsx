import { useState } from "react";
import Header from "./components/Header";
import HeroCard from "./components/HeroCard";
import RecentActivity from "./components/RecentActivity";
import AgentCard from "./components/AgentCard";
import AuthorizationEvents from "./components/AuthorizationEvents";
import StockAgentView from "./components/StockAgentView";
import SettingsModal from "./components/SettingsModal";
import SessionModal from "./components/SessionModal";
import ConfirmModal from "./components/ConfirmModal";
import OperationsModal from "./components/OperationsModal";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("operations");

  function handleSessionExpired() {
    // The SessionModal handles this automatically
  }

  return (
    <>
      <main className="shell">
        <Header onOpenSettings={() => setSettingsOpen(true)} />

        <div className="workspace-tabs" role="tablist" aria-label="Agent workspaces">
          <button
            className={`workspace-tab ${activeTab === "operations" ? "active" : ""}`}
            onClick={() => setActiveTab("operations")}
            role="tab"
            aria-selected={activeTab === "operations"}
          >
            Banking Agent
          </button>
          <button
            className={`workspace-tab ${activeTab === "stocks" ? "active" : ""}`}
            onClick={() => setActiveTab("stocks")}
            role="tab"
            aria-selected={activeTab === "stocks"}
          >
            Trading Agent
          </button>
        </div>

        {activeTab === "operations" ? (
          <>
            <section className="grid">
              <HeroCard onOpenOperations={() => setOperationsOpen(true)} />
              <RecentActivity />
            </section>

            <AgentCard onSessionExpired={handleSessionExpired} />
            <AuthorizationEvents />
          </>
        ) : (
          <StockAgentView />
        )}
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
