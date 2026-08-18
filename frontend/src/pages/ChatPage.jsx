import { useEffect, useRef, useState } from "react";
import MessageBubble from "../components/MessageBubble";
import { ArrowRightIcon, StopIcon } from "../components/icons";
import { useChat } from "../context/ChatContext";

export default function ChatPage() {
  const { activeConversation, streaming, sendMessage, stop, activeId } = useChat();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);

  const streamingText =
    streaming && streaming.conversationId === activeId ? streaming.text : null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeConversation?.messages?.length, streamingText]);

  useEffect(() => {
    setDraft("");
  }, [activeConversation?.id]);

  if (!activeConversation) {
    return (
      <div className="chat-window empty-state">
        <p>Select a conversation, or start a new one.</p>
      </div>
    );
  }

  // messages is null while a list summary is being hydrated with its full
  // history (see ChatContext's selectConversation)
  if (activeConversation.messages === null) {
    return <div className="chat-window empty-state" />;
  }

  const handleSend = () => {
    const text = draft.trim();
    if (!text || streamingText !== null) return;
    setDraft("");
    sendMessage(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-window">
      <div className="message-list" ref={scrollRef}>
        {activeConversation.messages.length === 0 && streamingText === null && (
          <div className="chat-placeholder">
            <h2>achat</h2>
            <p>Your own GPT-2, served by a hand-written KV-cache engine. Start typing below.</p>
          </div>
        )}
        {activeConversation.messages.map((m) => (
          <MessageBubble key={m.id} role={m.role} content={m.content} metrics={m.metrics} />
        ))}
        {streamingText !== null && (
          <MessageBubble role="assistant" content={streamingText} streaming />
        )}
      </div>

      <div className="composer">
        <textarea
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message achat…"
          rows={1}
        />
        {streamingText !== null ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={stop}
            aria-label="Stop generating"
            title="Stop generating"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-icon"
            onClick={handleSend}
            disabled={!draft.trim()}
            aria-label="Send message"
          >
            <ArrowRightIcon />
          </button>
        )}
      </div>
    </div>
  );
}
