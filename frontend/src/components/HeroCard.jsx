import { useApp } from "../context/AppContext";
import { formatCurrency } from "../utils/format";
import "./HeroCard.css";

export default function HeroCard({ onOpenOperations }) {
  const { account, isAuthenticated } = useApp();

  return (
    <article className="card hero">
      <h1>Banking assistant built for secure customer operations</h1>
      <p className="subtitle">
        Demo flow: authenticate via OneWelcome, then run AI-assisted support and
        transaction requests. Designed for stakeholder demos and pilot
        conversations.
        <br />
        The agent is based on Llama 3.1 and hosted on Ollama, Model 3.1:8b.
      </p>

      {!isAuthenticated ? (
        <div className="auth-note">
          Please authenticate to view balances, activity, and secure operations.
        </div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Available Balance</div>
              <div className="stat-value">
                {formatCurrency(account.availableBalance)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Savings Account</div>
              <div className="stat-value">
                {formatCurrency(account.savingsBalance)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Risk Status</div>
              <div className="stat-value">{account.riskStatus}</div>
            </div>
          </div>

          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Questions Asked</div>
              <div className="stat-value">{account.questionsAsked}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Questions Answered</div>
              <div className="stat-value">{account.questionsAnswered}</div>
            </div>
            <div className="stat clickable" onClick={onOpenOperations}>
              <div className="stat-label">Operations Performed</div>
              <div className="stat-value">{account.operationsPerformed}</div>
            </div>
          </div>
        </>
      )}
    </article>
  );
}
