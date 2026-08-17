import { useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import AuthScreen from "./components/AuthScreen";
import { createMessage } from "./mockData";
import { streamCompletion, stopStream, createConversation } from "./api";
import { useAuth } from "./context/AuthContext";

// Backend Conversation shape (id/title/messages/created_at/updated_at) into
// the frontend's shape (updatedAt, messages with local ids for React keys).
function toFrontendConversation(backendConv) {
  return {
    id: backendConv.id,
    title: backendConv.title,
    updatedAt: backendConv.updated_at,
    messages: backendConv.messages.map((m) => createMessage(m.role, m.content)),
  };
}

export default function App() {
  const { user, loading: authLoading } = useAuth();

  // Minimal Phase 2 patch: no chat list UI yet (Phase 4), so this holds
  // exactly one real backend-created conversation at a time instead of
  // mockData.js's hardcoded seed list.
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [modelName, setModelName] = useState("gpt2");
  const [useCache, setUseCache] = useState(true);
  const [maxNewTokens, setMaxNewTokens] = useState(256);
  // { conversationId, text } while a real reply is streaming in, else null
  const [streaming, setStreaming] = useState(null);
  const [metrics, setMetrics] = useState(null);
  // AbortController for whichever streamCompletion() call is in flight, so
  // the Stop button can cancel the client-side fetch; null when idle
  const abortRef = useRef(null);

  useEffect(() => {
    // wait for the auth check to resolve, and only create a conversation
    // once actually logged in -- /conversations is auth-protected, so
    // firing this before `user` exists would just 401
    if (user) handleNewChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;

  const handleNewChat = async () => {
    try {
      const backendConv = await createConversation();
      const conv = toFrontendConversation(backendConv);
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  };

  const appendAssistantMessage = (conversationId, content) => {
    const assistantMessage = createMessage("assistant", content);
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, assistantMessage], updatedAt: new Date().toISOString() }
          : c
      )
    );
  };

  const handleSendMessage = async (text) => {
    if (streaming) return;
    const conversationId = activeId;
    const userMessage = createMessage("user", text);

    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title: c.messages.length === 0 ? deriveTitle(text) : c.title,
              messages: [...c.messages, userMessage],
              updatedAt: new Date().toISOString(),
            }
          : c
      )
    );

    setStreaming({ conversationId, text: "" });
    setMetrics(null);

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = "";
    try {
      await streamCompletion(
        {
          modelName,
          promptText: text,
          // conversation id doubles as the backend session id, so per-session
          // chat history in GPTKVEngine/HFEngine lines up with the sidebar's
          // notion of a conversation
          sessionId: conversationId,
          useCache,
          maxNewTokens,
        },
        {
          onToken: (delta, tokenMetrics) => {
            accumulated += delta;
            setStreaming({ conversationId, text: accumulated });
            setMetrics(tokenMetrics);
          },
          onDone: (doneMetrics) => {
            setMetrics(doneMetrics);
          },
        },
        { signal: controller.signal }
      );
      // covers both a normal finish and a stop: aborting the fetch resolves
      // streamCompletion quietly (see api.js) rather than throwing, so
      // whatever text streamed in before the stop is kept as a real message
      appendAssistantMessage(conversationId, accumulated || "(empty response)");
      setStreaming(null);
    } catch (err) {
      setStreaming(null);
      appendAssistantMessage(
        conversationId,
        `⚠️ Couldn't reach the backend: ${err.message}. Is uvicorn running on port 8010?`
      );
    } finally {
      abortRef.current = null;
    }
  };

  const handleStop = (conversationId) => {
    // stop the server's generation loop (frees CPU on the free tier) and
    // abort the client-side fetch (stops waiting on a stream we're no
    // longer reading) -- streamCompletion's finally-equivalent path above
    // still runs and appends whatever text had already streamed in
    stopStream(conversationId);
    abortRef.current?.abort();
  };

  // still checking for an existing session (GET /auth/me) -- render nothing
  // rather than flashing the login screen before the check resolves
  if (authLoading) return null;

  if (!user) return <AuthScreen />;

  return (
    <div className="app-shell">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNewChat={handleNewChat}
      />
      <ChatWindow
        conversation={activeConversation}
        onSendMessage={handleSendMessage}
        onStop={() => handleStop(activeId)}
        streamingText={
          streaming && streaming.conversationId === activeId ? streaming.text : null
        }
        modelName={modelName}
        onModelChange={setModelName}
        useCache={useCache}
        onUseCacheChange={setUseCache}
        maxNewTokens={maxNewTokens}
        onMaxNewTokensChange={setMaxNewTokens}
        metrics={metrics}
      />
    </div>
  );
}

function deriveTitle(text) {
  const trimmed = text.trim();
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
}
