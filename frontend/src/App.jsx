import { Routes, Route, Navigate } from "react-router-dom";
import TopBar from "./components/TopBar";
import Rail from "./components/Rail";
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
  if (loading) return null;

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
        <Route path="/settings" element={<AppShell wide><SettingsPage /></AppShell>} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </ChatProvider>
  );
}

// `wide` pages (settings) take the full body width; the chat view opens
// the conversation panel as a click-to-open flyout, not a permanent
// sidebar -- redesigned away from the old always-visible-unless-collapsed
// column, which competed with the chat for space and needed a separate
// mobile-only override to avoid overflowing narrow screens.
function AppShell({ children, wide = false }) {
  const { panelCollapsed, togglePanel } = useChat();
  const panelOpen = !wide && !panelCollapsed;

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <Rail />
        {panelOpen && <ConversationPanel />}
        {/* dims the chat and closes the flyout on an outside tap/click */}
        {panelOpen && (
          <button
            type="button"
            className="app-body-backdrop"
            onClick={togglePanel}
            aria-label="Close chat list"
            tabIndex={-1}
          />
        )}
        {children}
      </div>
    </div>
  );
}
