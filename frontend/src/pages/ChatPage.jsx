import { useEffect, useRef, useState } from "react";
import MessageBubble from "../components/MessageBubble";
import { ArrowRightIcon, StopIcon } from "../components/icons";
import { useChat } from "../context/ChatContext";

export default function ChatPage() {
  const { activeConversation, streaming, sendMessage, stop, activeId, hydrationError, retryHydration } =
    useChat();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const streamingText =
    streaming && streaming.conversationId === activeId ? streaming.text : null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeConversation?.messages?.length, streamingText]);

  useEffect(() => {
    setDraft("");
  }, [activeConversation?.id]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }, [draft]);

  // Neither "nothing selected" nor "still loading" gets an early return any
  // more: both used to render a screen with no composer, so on mobile --
  // where the drawer is closed by default -- the app looked broken, with no
  // way to type and no visible way out. The composer is always available;
  // sending with nothing selected creates a conversation (ChatContext's
  // sendMessage handles the null case).
  // messages stays null both while history is loading and after that load
  // failed -- hydrationError is what separates them, so a failure shows a
  // retry instead of a skeleton that never resolves.
  const loading = activeConversation?.messages === null && !hydrationError;
  const messages = activeConversation?.messages ?? [];

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
      {hydrationError ? (
        <div className="message-list">
          <div className="chat-placeholder chat-error" role="alert">
            <h2>Couldn't load this conversation</h2>
            <p>{hydrationError}</p>
            <button type="button" className="btn btn-ghost" onClick={retryHydration}>
              Try again
            </button>
          </div>
        </div>
      ) : loading ? (
        <div className="message-list chat-skeleton" aria-busy="true" aria-hidden="true">
          <span className="skeleton-line short" />
          <span className="skeleton-line" />
          <span className="skeleton-line medium" />
        </div>
      ) : (
        <div className="message-list" ref={scrollRef}>
          {messages.length === 0 && streamingText === null && (
            <div className="chat-placeholder">
              <h2>cachegpt</h2>
              <p>Your own GPT-2, served by a hand-written KV-cache engine. Start typing below.</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} role={m.role} content={m.content} metrics={m.metrics} />
          ))}
          {streamingText !== null && (
            <MessageBubble role="assistant" content={streamingText} streaming />
          )}
        </div>
      )}

      <div className="composer">
        <div className="composer-shell">
          <textarea
            ref={inputRef}
            className="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message cachegpt…"
            rows={1}
            aria-label="Message cachegpt"
            aria-keyshortcuts="Enter"
          />
          {streamingText !== null ? (
            <button
              type="button"
              className="btn btn-ghost btn-icon composer-send"
              onClick={stop}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-icon composer-send"
              onClick={handleSend}
              disabled={!draft.trim()}
              aria-label="Send message"
            >
              <ArrowRightIcon />
            </button>
          )}
        </div>
        <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
      </div>
    </div>
  );
}
