import { useState, useEffect, useRef } from "react";
import { useApp, resolveDisplayName } from "../context/AppContext";
import "./Header.css";

export default function Header({ onOpenSettings }) {
  const { isAuthenticated, theme, toggleTheme } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  const token = isAuthenticated ? localStorage.getItem("access_token") : "";
  const displayName = isAuthenticated ? resolveDisplayName() : "Guest User";

  useEffect(() => {
    function handleClick(e) {
      if (!menuOpen) return;
      if (buttonRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  function authAction() {
    setMenuOpen(false);
    if (token) {
      const idToken = localStorage.getItem("id_token");
      const query = idToken ? `?id_token_hint=${encodeURIComponent(idToken)}` : "";
      window.location.href = `/auth/logout${query}`;
    } else {
      window.location.href = "/auth/login";
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <img
          className="brand-logo"
          src="https://productpod-bfsi-deployment.in.tryciam.onewelcome.net/training/login/ui/resources/theme/img/thales-logo-white.png"
          alt="Thales"
        />
      </div>
      <div className="topbar-title">Agentic AI Demo</div>
      <div className="top-actions">
        <button
          ref={buttonRef}
          className="user-menu-button btn btn-edit"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="material-symbols-outlined">account_circle</span>
          <span>{displayName}</span>
          <span className="chev">▼</span>
        </button>

        {menuOpen && (
          <div ref={panelRef} className="user-menu-panel open">
            <h3 className="menu-title">Account Menu</h3>
            <div className="menu-status-row">
              <span className={`status-pill ${token ? "" : "offline"}`}>
                {token ? "Authenticated" : "Not Signed In"}
              </span>
            </div>
            <div className="menu-theme-row">
              <span className="theme-label">
                {theme === "dark" ? "Dark mode" : "Light mode"}
              </span>
              <div className="theme-toggle-group">
              <span
                className={`material-symbols-outlined theme-icon ${
                  theme === "dark" ? "" : "active"
                }`}
                aria-hidden="true"
              >
                light_mode
              </span>
              <label className="switch" aria-label="Toggle dark mode">
                <input
                  type="checkbox"
                  checked={theme === "dark"}
                  onChange={toggleTheme}
                />
                <span className="slider" />
              </label>
              <span
                className={`material-symbols-outlined theme-icon ${
                  theme === "dark" ? "active" : ""
                }`}
                aria-hidden="true"
              >
                dark_mode
              </span>
              </div>
            </div>
            <button
              className="menu-item btn btn-edit"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <span className="material-symbols-outlined">settings</span>
              Settings
            </button>
            <div className="user-menu-footer">
              <button
                className={`btn ${token ? "btn-delete" : "btn-login"}`}
                onClick={authAction}
              >
                <span className="material-symbols-outlined">
                  {token ? "logout" : "login"}
                </span>
                {token ? "Logout" : "Login with OneWelcome"}
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
