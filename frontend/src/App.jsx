import { Routes, Route, Navigate } from "react-router-dom";
import TopBar from "./components/TopBar";
import ConversationPanel from "./components/ConversationPanel";
import AuthScreen from "./components/AuthScreen";
import LandingPage from "./pages/LandingPage";
import ChatPage from "./pages/ChatPage";
import SettingsPage from "./pages/SettingsPage";
import { useAuth } from "./context/AuthContext";
import { ChatProvider, useChat } from "./context/ChatContext";

export default function App() {
  const { user, loading } = useAuth();

  // still checking for an existing session (GET /auth/me) -- render nothing
  // rather than flashing the landing page before the check resolves
  if (loading) {
    return (
      <main className="app-loading" aria-busy="true" aria-label="Loading cachegpt">
        <div className="app-loading-mark" aria-hidden="true" />
        <strong>cachegpt</strong>
        <span>Preparing your workspace…</span>
      </main>
    );
  }

  // Logged out: landing page at /, auth screens, everything else bounces
  // back to the landing page.
  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<AuthScreen mode="login" />} />
        <Route path="/signup" element={<AuthScreen mode="signup" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // Logged in: the app lives under /chat, and /, /login, /signup all
  // redirect there -- a signed-in user has no use for the marketing page
  // or a second login form.
  return (
    <ChatProvider>
      <Routes>
        <Route path="/chat" element={<AppShell><ChatPage /></AppShell>} />
        <Route path="/settings" element={<AppShell><SettingsPage /></AppShell>} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </ChatProvider>
  );
}

// One drawer owns navigation at every width: it slides over the content
// rather than pushing it, and holds what the old 56px icon rail used to
// keep permanently on screen (new chat, settings, theme, account, logout)
// alongside the conversation list. Two chrome layers collapsed into one
// menu, so the chat itself gets the whole viewport by default.
function AppShell({ children }) {
  const { panelCollapsed, togglePanel } = useChat();
  const panelOpen = !panelCollapsed;

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        {panelOpen && <ConversationPanel />}
        {/* closes the drawer on an outside tap; deliberately transparent,
            so the content stays fully readable beside the open drawer */}
        {panelOpen && (
          <button
            type="button"
            className="app-body-backdrop"
            onClick={togglePanel}
            aria-label="Close menu"
            tabIndex={-1}
          />
        )}
        {children}
      </div>
    </div>
  );
}
