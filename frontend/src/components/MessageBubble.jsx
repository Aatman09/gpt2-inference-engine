import ReactMarkdown from "react-markdown";

// The landing page promises tokens/sec, time-to-first-token, peak memory and
// cache state on every reply, so the receipt renders all four in that order.
// A value is omitted rather than zero-filled when the backend didn't measure
// it -- a stopped or failed generation shows what it has, nothing invented.
function metricItems(metrics) {
  const items = [];
  if (metrics.tokens_per_sec != null) {
    items.push({
      key: "rate",
      label: `${metrics.tokens_per_sec.toFixed(0)} tok/s`,
      title: "Tokens generated per second for this reply",
    });
  }
  if (metrics.ttft_ms != null) {
    items.push({
      key: "ttft",
      label: `TTFT ${metrics.ttft_ms.toFixed(0)}ms`,
      title: "Time to first token — how long until this reply started streaming",
    });
  }
  if (metrics.peak_memory_mb != null) {
    items.push({
      key: "memory",
      label: `${metrics.peak_memory_mb.toFixed(0)} MB peak`,
      title: "Peak memory the server held while generating this reply",
    });
  }
  if (metrics.cache_used != null) {
    items.push({
      key: "cache",
      label: `KV cache: ${metrics.cache_used ? "on" : "off"}`,
      title: metrics.cache_used
        ? "KV cache reused attention state across turns for this reply"
        : "KV cache was off — attention was recomputed from scratch for this reply",
    });
  }
  return items;
}

export default function MessageBubble({ role, content, streaming, metrics }) {
  const isUser = role === "user";
  const items = !isUser && metrics ? metricItems(metrics) : [];
  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-role">{isUser ? "You" : "cachegpt"}</div>
      <div className="message-body">
        {isUser ? content : <ReactMarkdown>{content}</ReactMarkdown>}
        {streaming && <span className="cursor" />}
      </div>
      {items.length > 0 && (
        <div className="message-metrics">
          {items.map((item, i) => (
            <span key={item.key} className="message-metric">
              {i > 0 && <span aria-hidden="true">·</span>}
              <span title={item.title}>{item.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
