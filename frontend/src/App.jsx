import { useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import { initialConversations, createConversation, createMessage } from "./mockData";
import { fetchCompletion } from "./api";

export default function App() {
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState(initialConversations[0].id);
  // { conversationId, text } while a mock reply is "streaming" in, else null
  const [streaming, setStreaming] = useState(null);
  const streamTimer = useRef(null);

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

  const animateReveal = (conversationId, fullReply) => {
    let shown = 0;
    const tick = () => {
      shown += Math.max(1, Math.floor(fullReply.length / 60));
      setStreaming({ conversationId, text: fullReply.slice(0, shown) });
      if (shown < fullReply.length) {
        streamTimer.current = setTimeout(tick, 12);
      } else {
        appendAssistantMessage(conversationId, fullReply);
        setStreaming(null);
      }
    };
    streamTimer.current = setTimeout(tick, 60);
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

    try {
      const fullReply = await fetchCompletion(text);
      // network call is done; switch from "waiting" to the local reveal animation
      animateReveal(conversationId, fullReply || "(empty response)");
    } catch (err) {
      setStreaming(null);
      appendAssistantMessage(
        conversationId,
        `⚠️ Couldn't reach the backend: ${err.message}. Is uvicorn running on port 8010?`
      );
    }
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
        streamingText={
          streaming && streaming.conversationId === activeId ? streaming.text : null
        }
      />
    </div>
  );
}

function deriveTitle(text) {
  const trimmed = text.trim();
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
}
