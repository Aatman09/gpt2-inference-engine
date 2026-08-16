import { useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import { initialConversations, createConversation, createMessage } from "./mockData";
import { streamCompletion, stopStream } from "./api";

export default function App() {
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState(initialConversations[0].id);
  const [modelName, setModelName] = useState("gpt2");
  const [useCache, setUseCache] = useState(true);
  const [maxNewTokens, setMaxNewTokens] = useState(256);
  // { conversationId, text } while a real reply is streaming in, else null
  const [streaming, setStreaming] = useState(null);
  const [metrics, setMetrics] = useState(null);
  // AbortController for whichever streamCompletion() call is in flight, so
  // the Stop button can cancel the client-side fetch; null when idle
  const abortRef = useRef(null);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;

  const handleNewChat = () => {
    const conv = createConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
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
