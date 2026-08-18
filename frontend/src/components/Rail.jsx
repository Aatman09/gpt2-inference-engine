import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../context/ChatContext";
import { useTheme } from "../context/ThemeContext";
import { PlusIcon, HistoryIcon, SettingsIcon, PanelIcon, SunIcon, MoonIcon } from "./icons";

export default function Rail() {
  const { user, logout } = useAuth();
  const { newChat, panelCollapsed, togglePanel } = useChat();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const handleNewChat = async () => {
    await newChat();
    navigate("/");
  };

  return (
    <nav className="rail">
      <button
        type="button"
        className="rail-link"
        onClick={togglePanel}
        aria-label={panelCollapsed ? "Show chat list" : "Hide chat list"}
        title={panelCollapsed ? "Show chat list" : "Hide chat list"}
      >
        <PanelIcon />
      </button>

      <button
        type="button"
        className="btn btn-primary btn-icon"
        onClick={handleNewChat}
        aria-label="New chat"
        title="New chat"
      >
        <PlusIcon />
      </button>

      <NavLink
        to="/history"
        className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}
        aria-label="History"
        title="History"
      >
        <HistoryIcon />
      </NavLink>

      <NavLink
        to="/settings"
        className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}
        aria-label="Settings"
        title="Settings"
      >
        <SettingsIcon />
      </NavLink>

      <div className="rail-spacer" />

      <button
        type="button"
        className="rail-link"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      <div className="rail-avatar" title={user?.name}>
        {user?.name?.[0]?.toUpperCase() ?? "?"}
      </div>

      <button
        type="button"
        className="rail-link rail-logout"
        onClick={logout}
        aria-label="Log out"
        title="Log out"
      >
        ⏻
      </button>
    </nav>
  );
}
