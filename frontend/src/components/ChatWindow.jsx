import { useEffect, useRef, useState } from "react";
import MessageBubble from "./MessageBubble";

export default function ChatWindow({ conversation, onSendMessage, streamingText }) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation?.messages.length, streamingText]);

  useEffect(() => {
    setDraft("");
  }, [conversation?.id]);

  if (!conversation) {
    return (
      <div className="chat-window empty-state">
        <p>Select a conversation, or start a new one.</p>
      </div>
    );
  }

  const handleSend = () => {
    const text = draft.trim();
    if (!text || streamingText !== null) return;
    setDraft("");
    onSendMessage(text);
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
        {conversation.messages.length === 0 && streamingText === null && (
          <div className="chat-placeholder">
            <h2>achat</h2>
            <p>Your own GPT-2, in a ChatGPT-style shell. Start typing below.</p>
          </div>
        )}
        {conversation.messages.map((m) => (
          <MessageBubble key={m.id} role={m.role} content={m.content} />
        ))}
        {streamingText !== null && (
          <MessageBubble role="assistant" content={streamingText} streaming />
        )}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message achat…"
          rows={1}
        />
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={!draft.trim() || streamingText !== null}
          aria-label="Send message"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
