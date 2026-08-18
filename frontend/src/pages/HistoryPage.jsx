import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PlusIcon, TrashIcon, PencilIcon } from "../components/icons";
import { useChat } from "../context/ChatContext";

// "Today" / "Yesterday" / weekday / date, matching the mockup's Updated column
function formatUpdated(iso) {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((startOfToday - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Per-conversation speed/cache aren't persisted server-side (only live
// per-request metrics exist), so this reads whatever the last assistant turn
// recorded in this session and shows a dash otherwise.
function lastTurnMetrics(conversation) {
  if (!conversation.messages) return null;
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i];
    if (m.role === "assistant" && m.metrics) return m.metrics;
  }
  return null;
}

export default function HistoryPage() {
  const { conversations, selectConversation, newChat, removeConversation, renameConversationTitle } =
    useChat();
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const handleRename = (conv) => {
    const next = window.prompt("Rename chat", conv.title);
    if (next !== null) renameConversationTitle(conv.id, next);
  };

  const filtered = conversations
    .filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const openConversation = (id) => {
    selectConversation(id);
    navigate("/");
  };

  const handleNewChat = async () => {
    await newChat();
    navigate("/");
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Chat history</h2>
        <button type="button" className="btn btn-primary" onClick={handleNewChat}>
          <PlusIcon />
          New chat
        </button>
      </div>

      <div className="field page-search">
        <input
          className="input"
          placeholder="Search chats…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="page-empty">
          {conversations.length === 0 ? "No chats yet." : "No chats match that search."}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Chat</th>
              <th>Last speed</th>
              <th>KV cache</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((conv) => {
              const metrics = lastTurnMetrics(conv);
              return (
                <tr key={conv.id}>
                  <td className="history-row-title" onClick={() => openConversation(conv.id)}>
                    {conv.title}
                  </td>
                  <td>
                    {metrics?.tokens_per_sec === undefined ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={`tag ${metrics.cache_used ? "tag-accent" : "tag-outline"}`}>
                        {metrics.tokens_per_sec.toFixed(0)} tok/s
                      </span>
                    )}
                  </td>
                  <td className="text-muted">
                    {metrics?.cache_used === undefined ? "—" : metrics.cache_used ? "On" : "Off"}
                  </td>
                  <td className="text-muted">{formatUpdated(conv.updatedAt)}</td>
                  <td>
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => handleRename(conv)}
                        aria-label={`Rename "${conv.title}"`}
                        title="Rename chat"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => removeConversation(conv.id)}
                        aria-label={`Delete "${conv.title}"`}
                        title="Delete chat"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
