import { useAuth } from "../context/AuthContext";

export default function Sidebar({ conversations, activeId, onSelect, onNewChat, onDelete }) {
  const { user, logout } = useAuth();

  const handleDeleteClick = (e, id) => {
    e.stopPropagation(); // don't also trigger onSelect on the parent button
    onDelete(id);
  };

  return (
    <aside className="sidebar">
      <button className="new-chat-btn" onClick={onNewChat}>
        <span className="plus">+</span> New chat
      </button>

      <nav className="conversation-list">
        {conversations
          .slice()
          .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
          .map((conv) => (
            <div
              key={conv.id}
              className={`conversation-item${conv.id === activeId ? " active" : ""}`}
              onClick={() => onSelect(conv.id)}
              title={conv.title}
            >
              <span className="conversation-title">{conv.title}</span>
              <button
                className="conversation-delete"
                onClick={(e) => handleDeleteClick(e, conv.id)}
                aria-label={`Delete "${conv.title}"`}
                title="Delete chat"
              >
                ×
              </button>
            </div>
          ))}
      </nav>

      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="avatar">{user?.name?.[0]?.toUpperCase() ?? "?"}</div>
          <span>{user?.name}</span>
        </div>
        <button className="logout-btn" onClick={logout}>
          Log out
        </button>
      </div>
    </aside>
  );
}
