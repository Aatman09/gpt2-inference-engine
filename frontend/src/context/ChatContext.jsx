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
      // metrics is persisted alongside role/content for assistant replies --
      // dropping it here is what used to make every number vanish on reload
      ? backendConv.messages.map((m) => ({ ...createMessage(m.role, m.content), metrics: m.metrics ?? null }))
      : null,
  };
}

// Token frames carry rate and TTFT; the done frame carries peak memory, cache
// state and the totals. Replacing one with the other loses half the promised
// numbers, so frames are merged into a single metrics object instead.
function mergeMetrics(previous, frame) {
  const values = { ...frame };
  delete values.type;
  delete values.text;
  return { ...previous, ...values };
}

export function ChatProvider({ children }) {
  const { user } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [modelName, setModelName] = useState("gpt2");
  const [useCache, setUseCache] = useState(true);
  const [maxNewTokens, setMaxNewTokens] = useState(256);
  // persisted so a deliberate "leave it open" choice survives reloads, but
  // the panel is a click-to-open flyout at every width now (not an
  // always-visible sidebar), so a first-ever visit defaults to closed --
  // opening on top of the chat unasked would hide the composer on load
  const [panelCollapsed, setPanelCollapsed] = useState(() => {
    const stored = localStorage.getItem("panelCollapsed");
    return stored !== null ? stored === "true" : true;
  });
  // { conversationId, text } while a real reply is streaming in, else null
  const [streaming, setStreaming] = useState(null);
  const [metrics, setMetrics] = useState(null);
  // AbortController for whichever streamCompletion() call is in flight, so
  // the Stop button can cancel the client-side fetch; null when idle
  const abortRef = useRef(null);
  // the conversation id the in-flight generation belongs to. Stop needs this
  // rather than activeId: switching chats mid-stream moves activeId, and
  // /stop would then cancel whatever the user just opened instead.
  const streamingIdRef = useRef(null);
  // { [conversationId]: message } for conversations whose history failed to
  // load. Without it messages stays null on failure and the view renders its
  // loading skeleton forever, with no way to retry.
  const [hydrationErrors, setHydrationErrors] = useState({});

  useEffect(() => {
    if (user) loadConversations();
    else {
      setConversations([]);
      setActiveId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  const hydrationError = activeId ? hydrationErrors[activeId] ?? null : null;

  const loadConversations = async () => {
    try {
      const summaries = await listConversations();
      const convs = summaries.map(toFrontendConversation);
      setConversations(convs);
      if (convs.length > 0) selectConversation(convs[0].id);
      else newChat();
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  };

  // Sidebar/history entries have no messages -- fetch the full conversation
  // lazily on selection rather than eagerly loading every chat's history.
  const selectConversation = async (id) => {
    setActiveId(id);
    await hydrateConversation(id);
  };

  const hydrateConversation = async (id) => {
    if (isDraftId(id)) return;
    const existing = conversations.find((c) => c.id === id);
    if (existing && existing.messages !== null) return;

    setHydrationErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const hydrated = toFrontendConversation(await getConversation(id));
      setConversations((prev) => prev.map((c) => (c.id === id ? hydrated : c)));
    } catch (err) {
      console.error("Failed to load conversation:", err);
      setHydrationErrors((prev) => ({
        ...prev,
        [id]: "We couldn't load this conversation's history.",
      }));
    }
  };

  const retryHydration = () => {
    if (activeId) hydrateConversation(activeId);
  };

  // Purely local -- no DB row until the user actually sends a message
  // (sendMessage creates the real conversation lazily). Without this, every
  // "+ New chat" click, and every ChatProvider remount that found zero
  // conversations, wrote an empty row that never got used -- the empty
  // "New chat" entries piling up in the sidebar.
  const newChat = () => {
    const draft = { id: `draft-${crypto.randomUUID()}`, title: "New chat", updatedAt: null, messages: [] };
    setConversations((prev) => [draft, ...prev]);
    setActiveId(draft.id);
    return draft.id;
  };

  const isDraftId = (id) => typeof id === "string" && id.startsWith("draft-");

  const removeConversation = async (id) => {
    // a draft only exists client-side -- nothing to delete on the server
    if (!isDraftId(id)) {
      try {
        await deleteConversation(id);
      } catch (err) {
        console.error("Failed to delete conversation:", err);
        return;
      }
    }
    setHydrationErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
    // a draft has no server-side row to rename yet -- the local title update
    // above is enough, and sendMessage's title-derivation only fires on an
    // empty title anyway, so a manual rename here still sticks
    if (isDraftId(id)) return;
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
    let conversationId = activeId;
    const userMessage = createMessage("user", text);

    // First message in a draft chat -- or with nothing selected at all --
    // creates the real DB row now, replacing the local placeholder id
    // everywhere (sidebar entry + activeId) before any request that needs a
    // real, persistable conversation id goes out. The null case matters
    // because the composer is always available now: typing is allowed even
    // when no conversation is open, and it starts one.
    let draftTitle = null;
    if (!conversationId || isDraftId(conversationId)) {
      const draftId = conversationId;
      // a user rename on the draft (still "New chat" server-side) must survive
      // the swap to the real row, or the auto-title logic below overwrites it
      draftTitle = draftId ? conversations.find((c) => c.id === draftId)?.title : null;
      try {
        const created = toFrontendConversation(await createConversation());
        conversationId = created.id;
        setConversations((prev) =>
          draftId
            ? prev.map((c) => (c.id === draftId ? { ...created, messages: [] } : c))
            // nothing to replace -- this is a brand new row, so add it
            : [{ ...created, messages: [] }, ...prev]
        );
        setActiveId(conversationId);
        // push the user's pre-send rename to the now-real row -- it only
        // existed locally on the draft, which had nothing to persist against
        if (draftTitle && draftTitle !== "New chat") {
          renameConversation(conversationId, draftTitle).catch((err) =>
            console.error("Failed to persist draft rename:", err)
          );
        }
      } catch (err) {
        console.error("Failed to create conversation:", err);
        return;
      }
    }

    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title:
                draftTitle && draftTitle !== "New chat"
                  ? draftTitle
                  : c.messages.length === 0
                    ? deriveTitle(text)
                    : c.title,
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
    streamingIdRef.current = conversationId;

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
            finalMetrics = mergeMetrics(finalMetrics, tokenMetrics);
            setMetrics(finalMetrics);
          },
          onDone: (doneMetrics) => {
            finalMetrics = mergeMetrics(finalMetrics, doneMetrics);
            setMetrics(finalMetrics);
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
      streamingIdRef.current = null;
    }
  };

  const stop = () => {
    // stop the server's generation loop (frees CPU on the free tier) and
    // abort the client-side fetch (stops waiting on a stream we're no
    // longer reading). The session id comes from the ref, not activeId --
    // the user may have switched conversations while this reply streams.
    const sessionId = streamingIdRef.current;
    if (sessionId) stopStream(sessionId);
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
        hydrationError,
        retryHydration,
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
