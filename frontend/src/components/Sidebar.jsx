export default function Sidebar({ conversations, activeId, onSelect, onNewChat }) {
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
          <div className="avatar">A</div>
          <span>Aries</span>
        </div>
      </div>
    </aside>
  );
}
