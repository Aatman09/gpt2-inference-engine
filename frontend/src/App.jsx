import { Routes, Route, Navigate } from "react-router-dom";
import TopBar from "./components/TopBar";
import Rail from "./components/Rail";
import ConversationPanel from "./components/ConversationPanel";
import AuthScreen from "./components/AuthScreen";
import ChatPage from "./pages/ChatPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import { useAuth } from "./context/AuthContext";
import { ChatProvider, useChat } from "./context/ChatContext";

export default function App() {
  const { user, loading } = useAuth();

  // still checking for an existing session (GET /auth/me) -- render nothing
  // rather than flashing the login screen before the check resolves
  if (loading) return null;

  if (!user) return <AuthScreen />;

  return (
    <ChatProvider>
      <AppShell />
    </ChatProvider>
  );
}

// separate component so it can read ChatContext (the provider is above it)
function AppShell() {
  const { panelCollapsed } = useChat();

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <Rail />
        <Routes>
          {/* the conversation panel only rides along with the chat view --
              history and settings are full-width pages */}
          <Route
            path="/"
            element={
              <>
                {!panelCollapsed && <ConversationPanel />}
                <ChatPage />
              </>
            }
          />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
