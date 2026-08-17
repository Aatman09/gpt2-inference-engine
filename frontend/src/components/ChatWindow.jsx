import { useEffect, useRef, useState } from "react";
import MessageBubble from "./MessageBubble";

const MODEL_OPTIONS = [
  { value: "gpt2", label: "GPT-2 (my KV-cache engine)" },
  { value: "qwen2.5-0.5b-instruct", label: "Qwen2.5-0.5B-Instruct" },
  { value: "smollm2-360m-instruct", label: "SmolLM2-360M-Instruct" },
];

function MetricsBar({ modelName, useCache, onUseCacheChange, metrics }) {
  const cacheApplicable = modelName === "gpt2";
  return (
    <div className="metrics-bar">
      <label className="cache-toggle">
        <input
          type="checkbox"
          checked={useCache}
          disabled={!cacheApplicable}
          onChange={(e) => onUseCacheChange(e.target.checked)}
        />
        KV cache {cacheApplicable ? (useCache ? "ON" : "OFF") : "(GPT-2 only)"}
      </label>
      {metrics && (
        <span className="metrics-readout">
          {metrics.ttft_ms !== undefined && `TTFT ${metrics.ttft_ms.toFixed(0)}ms`}
          {metrics.tokens_per_sec !== undefined &&
            ` · ${metrics.tokens_per_sec.toFixed(1)} tok/s`}
          {metrics.peak_memory_mb !== undefined &&
            ` · peak ${metrics.peak_memory_mb.toFixed(0)}MB`}
        </span>
      )}
    </div>
  );
}

const MAX_NEW_TOKENS_CAP = 512;

export default function ChatWindow({
  conversation,
  onSendMessage,
  onStop,
  streamingText,
  modelName,
  onModelChange,
  useCache,
  onUseCacheChange,
  maxNewTokens,
  onMaxNewTokensChange,
  metrics,
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation?.messages?.length, streamingText]);

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

  // messages is null while the sidebar summary is being hydrated with its
  // full history (see App.jsx's handleSelectConversation)
  if (conversation.messages === null) {
    return <div className="chat-window empty-state" />;
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
      <div className="model-bar">
        <select
          className="model-select"
          value={modelName}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={streamingText !== null}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <label className="max-tokens-field">
          Max tokens
          <input
            type="number"
            className="max-tokens-input"
            min={16}
            max={MAX_NEW_TOKENS_CAP}
            step={16}
            value={maxNewTokens}
            disabled={streamingText !== null}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isNaN(next)) return;
              const clamped = Math.min(Math.max(next, 16), MAX_NEW_TOKENS_CAP);
              onMaxNewTokensChange(clamped);
            }}
          />
        </label>
        <MetricsBar
          modelName={modelName}
          useCache={useCache}
          onUseCacheChange={onUseCacheChange}
          metrics={metrics}
        />
      </div>
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
        {streamingText !== null ? (
          <button
            className="send-btn stop-btn"
            onClick={onStop}
            aria-label="Stop generating"
            title="Stop generating"
          >
            ■
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!draft.trim()}
            aria-label="Send message"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
