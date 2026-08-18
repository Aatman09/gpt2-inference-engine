import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  streamCompletion,
  stopStream,
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  renameConversation,
} from "../api";
import { createMessage } from "../mockData";
import { useAuth } from "./AuthContext";

const ChatContext = createContext(null);

// Backend Conversation shape (id/title/messages/created_at/updated_at) into
// the frontend's shape (updatedAt, messages with local ids for React keys).
// List-view summaries (GET /conversations) have no messages field -- messages
// stays null to mean "not yet hydrated", distinct from "empty chat".
function toFrontendConversation(backendConv) {
  return {
    id: backendConv.id,
    title: backendConv.title,
    updatedAt: backendConv.updated_at,
    messages: backendConv.messages
      ? backendConv.messages.map((m) => createMessage(m.role, m.content))
      : null,
  };
}

export function ChatProvider({ children }) {
  const { user } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [modelName, setModelName] = useState("gpt2");
  const [useCache, setUseCache] = useState(true);
  const [maxNewTokens, setMaxNewTokens] = useState(256);
  // persisted so the collapsed/expanded choice survives reloads
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem("panelCollapsed") === "true"
  );
  // { conversationId, text } while a real reply is streaming in, else null
  const [streaming, setStreaming] = useState(null);
  const [metrics, setMetrics] = useState(null);
  // AbortController for whichever streamCompletion() call is in flight, so
  // the Stop button can cancel the client-side fetch; null when idle
  const abortRef = useRef(null);

  useEffect(() => {
    if (user) loadConversations();
    else {
      setConversations([]);
      setActiveId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;

  const loadConversations = async () => {
    try {
      const summaries = await listConversations();
      const convs = summaries.map(toFrontendConversation);
      setConversations(convs);
      if (convs.length > 0) selectConversation(convs[0].id);
      else await newChat();
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  };

  // Sidebar/history entries have no messages -- fetch the full conversation
  // lazily on selection rather than eagerly loading every chat's history.
  const selectConversation = async (id) => {
    setActiveId(id);
    const existing = conversations.find((c) => c.id === id);
    if (existing && existing.messages !== null) return;

    try {
      const hydrated = toFrontendConversation(await getConversation(id));
      setConversations((prev) => prev.map((c) => (c.id === id ? hydrated : c)));
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  };

  const newChat = async () => {
    try {
      const conv = toFrontendConversation(await createConversation());
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      return conv.id;
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  };

  const removeConversation = async (id) => {
    try {
      await deleteConversation(id);
    } catch (err) {
      console.error("Failed to delete conversation:", err);
      return;
    }
    setConversations((prev) => {
      const remaining = prev.filter((c) => c.id !== id);
      if (activeId === id) {
        if (remaining.length > 0) selectConversation(remaining[0].id);
        else setActiveId(null);
      }
      return remaining;
    });
  };

  const renameConversationTitle = async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // optimistic -- the sidebar updates immediately, reverting only if the
    // request fails
    const previous = conversations.find((c) => c.id === id)?.title;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    try {
      await renameConversation(id, trimmed);
    } catch (err) {
      console.error("Failed to rename conversation:", err);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: previous } : c)));
    }
  };

  const appendAssistantMessage = (conversationId, content, turnMetrics) => {
    const assistantMessage = { ...createMessage("assistant", content), metrics: turnMetrics };
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, assistantMessage], updatedAt: new Date().toISOString() }
          : c
      )
    );
  };

  const sendMessage = async (text) => {
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
    let finalMetrics = null;
    try {
      await streamCompletion(
        {
          modelName,
          promptText: text,
          // conversation id doubles as the backend session id
          sessionId: conversationId,
          useCache,
          maxNewTokens,
        },
        {
          onToken: (delta, tokenMetrics) => {
            accumulated += delta;
            setStreaming({ conversationId, text: accumulated });
            setMetrics(tokenMetrics);
            finalMetrics = tokenMetrics;
          },
          onDone: (doneMetrics) => {
            setMetrics(doneMetrics);
            finalMetrics = doneMetrics;
          },
        },
        { signal: controller.signal }
      );
      // covers both a normal finish and a stop: aborting the fetch resolves
      // streamCompletion quietly (see api.js) rather than throwing, so
      // whatever text streamed in before the stop is kept as a real message
      appendAssistantMessage(conversationId, accumulated || "(empty response)", finalMetrics);
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

  const stop = () => {
    // stop the server's generation loop (frees CPU on the free tier) and
    // abort the client-side fetch (stops waiting on a stream we're no
    // longer reading)
    stopStream(activeId);
    abortRef.current?.abort();
  };

  const togglePanel = () => {
    setPanelCollapsed((prev) => {
      localStorage.setItem("panelCollapsed", String(!prev));
      return !prev;
    });
  };

  return (
    <ChatContext.Provider
      value={{
        conversations,
        activeId,
        activeConversation,
        streaming,
        metrics,
        modelName,
        setModelName,
        useCache,
        setUseCache,
        maxNewTokens,
        setMaxNewTokens,
        panelCollapsed,
        togglePanel,
        selectConversation,
        newChat,
        removeConversation,
        renameConversationTitle,
        sendMessage,
        stop,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

function deriveTitle(text) {
  const trimmed = text.trim();
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
}
