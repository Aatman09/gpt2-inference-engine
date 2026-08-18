import ReactMarkdown from "react-markdown";

export default function MessageBubble({ role, content, streaming, metrics }) {
  const isUser = role === "user";
  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-role">{isUser ? "You" : "achat"}</div>
      <div className="message-body">
        {isUser ? content : <ReactMarkdown>{content}</ReactMarkdown>}
        {streaming && <span className="cursor" />}
      </div>
      {!isUser && metrics && (
        <div className="message-metrics">
          {metrics.tokens_per_sec !== undefined && (
            <span title="Tokens generated per second for this reply">
              {metrics.tokens_per_sec.toFixed(0)} tok/s
            </span>
          )}
          {metrics.cache_used !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span
                title={
                  metrics.cache_used
                    ? "KV cache reused attention state across turns for this reply"
                    : "KV cache was off — attention was recomputed from scratch for this reply"
                }
              >
                KV cache: {metrics.cache_used ? "on" : "off"}
              </span>
            </>
          )}
          {metrics.ttft_ms !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span title="Time to first token — how long until this reply started streaming">
                TTFT {metrics.ttft_ms.toFixed(0)}ms
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
