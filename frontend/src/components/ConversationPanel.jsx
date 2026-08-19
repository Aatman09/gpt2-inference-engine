import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChat } from "../context/ChatContext";
import { PlusIcon, TrashIcon, PencilIcon } from "./icons";

export default function ConversationPanel() {
  const {
    conversations,
    activeId,
    selectConversation,
    newChat,
    removeConversation,
    renameConversationTitle,
  } = useChat();
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const sorted = conversations
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const open = (id) => {
    selectConversation(id);
    navigate("/chat");
  };

  const handleNewChat = async () => {
    await newChat();
    navigate("/chat");
  };

  const startEditing = (e, conv) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setDraftTitle(conv.title);
  };

  const commitEditing = () => {
    if (editingId) renameConversationTitle(editingId, draftTitle);
    setEditingId(null);
  };

  return (
    <aside className="conversation-panel">
      <button type="button" className="btn btn-ghost btn-block new-chat-btn" onClick={handleNewChat}>
        <PlusIcon />
        New chat
      </button>

      <nav className="conversation-list">
        {sorted.length === 0 && <div className="conversation-empty">No chats yet.</div>}
        {sorted.map((conv) => (
          <div
            key={conv.id}
            className={`conversation-item${conv.id === activeId ? " active" : ""}`}
            onClick={() => open(conv.id)}
            title={conv.title}
          >
            {editingId === conv.id ? (
              <input
                ref={inputRef}
                className="conversation-rename"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEditing();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <>
                <span className="conversation-title">{conv.title}</span>
                <button
                  type="button"
                  className="conversation-action"
                  onClick={(e) => startEditing(e, conv)}
                  aria-label={`Rename "${conv.title}"`}
                  title="Rename"
                >
                  <PencilIcon size={13} />
                </button>
                <button
                  type="button"
                  className="conversation-action conversation-delete"
                  onClick={(e) => {
                    e.stopPropagation(); // don't also trigger the row's open()
                    removeConversation(conv.id);
                  }}
                  aria-label={`Delete "${conv.title}"`}
                  title="Delete chat"
                >
                  <TrashIcon size={13} />
                </button>
              </>
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
