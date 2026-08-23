import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../context/ChatContext";
import { useTheme } from "../context/ThemeContext";
import {
  PlusIcon,
  TrashIcon,
  PencilIcon,
  CloseIcon,
  MoreIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  LogOutIcon,
} from "./icons";

// The drawer owns all navigation now -- the 56px icon rail it replaced put
// new-chat/settings/theme/logout permanently on screen beside a separate
// conversation column, two chrome layers for what is really one menu.
export default function ConversationPanel() {
  const {
    conversations,
    activeId,
    selectConversation,
    newChat,
    removeConversation,
    renameConversationTitle,
    togglePanel,
  } = useChat();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");
  // which conversation row has its ... menu open, if any
  const [rowMenuId, setRowMenuId] = useState(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const inputRef = useRef(null);
  const accountRef = useRef(null);
  const deleteDialogRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteDialogRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === "Escape") setDeleteTarget(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleteTarget]);

  // one dismissal path for both menus: any pointer press outside the open
  // menu, or Escape
  useEffect(() => {
    if (!rowMenuId && !accountOpen) return;
    const onPointerDown = (e) => {
      if (accountRef.current?.contains(e.target)) return;
      if (e.target.closest?.(".conversation-row-menu, .conversation-action")) return;
      setRowMenuId(null);
      setAccountOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setRowMenuId(null);
        setAccountOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [rowMenuId, accountOpen]);

  const sorted = conversations
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  // On a phone the drawer covers the chat, so picking something has to
  // dismiss it. From 900px up it is a persistent column beside the chat
  // (see index.css) and closing it on every click would be hostile.
  const closeIfOverlay = () => {
    if (window.matchMedia("(max-width: 899px)").matches) togglePanel();
  };

  const open = (id) => {
    selectConversation(id);
    navigate("/chat");
    closeIfOverlay();
  };

  const handleNewChat = async () => {
    await newChat();
    navigate("/chat");
    closeIfOverlay();
  };

  const goSettings = () => {
    navigate("/settings");
    setAccountOpen(false);
    closeIfOverlay();
  };

  const startEditing = (conv) => {
    setRowMenuId(null);
    setEditingId(conv.id);
    setDraftTitle(conv.title);
  };

  const commitEditing = () => {
    if (editingId) renameConversationTitle(editingId, draftTitle);
    setEditingId(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await removeConversation(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <aside className="conversation-panel">
      <div className="drawer-head">
        <Link className="drawer-brand" to="/chat" onClick={() => closeIfOverlay()}>
          achat
        </Link>
        <button
          type="button"
          className="icon-btn"
          onClick={togglePanel}
          aria-label="Close menu"
          title="Close menu"
        >
          <CloseIcon />
        </button>
      </div>

      <button type="button" className="drawer-nav-item" onClick={handleNewChat}>
        <PlusIcon size={16} />
        New chat
      </button>

      <div className="drawer-section-label">Recents</div>

      <nav className="conversation-list">
        {sorted.length === 0 && <div className="conversation-empty">No chats yet.</div>}
        {sorted.map((conv) => (
          <div
            key={conv.id}
            className={`conversation-item${conv.id === activeId ? " active" : ""}`}
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
                <button
                  type="button"
                  className="conversation-title"
                  onClick={() => open(conv.id)}
                  title={conv.title}
                >
                  {conv.title}
                </button>
                {/* always rendered, not hover-revealed: the old hover-only
                    actions were unreachable by touch and keyboard, which the
                    2026-08-18 critique flagged as a P1 */}
                <button
                  type="button"
                  className="conversation-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRowMenuId((id) => (id === conv.id ? null : conv.id));
                  }}
                  aria-haspopup="menu"
                  aria-expanded={rowMenuId === conv.id}
                  aria-label={`Actions for "${conv.title}"`}
                >
                  <MoreIcon size={16} />
                </button>

                {rowMenuId === conv.id && (
                  <div className="conversation-row-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditing(conv);
                      }}
                    >
                      <PencilIcon size={14} />
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRowMenuId(null);
                        setDeleteTarget(conv);
                      }}
                    >
                      <TrashIcon size={14} />
                      Delete
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </nav>

      {/* account row pinned to the bottom, its menu opening upward -- the
          rail's avatar, theme toggle, settings and logout all live here now */}
      <div className="drawer-account" ref={accountRef}>
        {accountOpen && (
          <div className="drawer-account-menu" role="menu">
            <button type="button" role="menuitem" onClick={goSettings}>
              <SettingsIcon size={16} />
              Settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                toggleTheme();
                setAccountOpen(false);
              }}
            >
              {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <hr className="hr" />
            <button type="button" role="menuitem" className="is-danger" onClick={logout}>
              <LogOutIcon size={16} />
              Log out
            </button>
          </div>
        )}

        <button
          type="button"
          className="drawer-account-trigger"
          onClick={() => setAccountOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={accountOpen}
        >
          <span className="rail-avatar">{user?.name?.[0]?.toUpperCase() ?? "?"}</span>
          <span className="drawer-account-name">{user?.name}</span>
          <MoreIcon size={16} />
        </button>
      </div>

      {deleteTarget && (
        <div className="confirm-layer" role="presentation">
          <div ref={deleteDialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" tabIndex={-1}>
            <h2 id="delete-title">Delete this chat?</h2>
            <p id="delete-description">“{deleteTarget.title}” will be permanently removed.</p>
            <div className="confirm-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete}>Delete chat</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
