export default function MessageBubble({ role, content, streaming }) {
  const isUser = role === "user";
  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-avatar">{isUser ? "A" : "G"}</div>
      <div className="message-bubble">
        {content}
        {streaming && <span className="cursor" />}
      </div>
    </div>
  );
}
