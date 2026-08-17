import { useAuth } from "../context/AuthContext";

export default function Sidebar({ conversations, activeId, onSelect, onNewChat }) {
  const { user, logout } = useAuth();

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
            <button
              key={conv.id}
              className={`conversation-item${conv.id === activeId ? " active" : ""}`}
              onClick={() => onSelect(conv.id)}
              title={conv.title}
            >
              {conv.title}
            </button>
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
