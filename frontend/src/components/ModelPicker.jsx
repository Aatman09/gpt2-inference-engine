import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { useChat } from "../context/ChatContext";

export const MODEL_OPTIONS = [
  {
    value: "gpt2",
    label: "GPT-2",
    engine: "My KV-cache engine, trained from scratch",
  },
  {
    value: "qwen2.5-0.5b-instruct",
    label: "Qwen2.5-0.5B-Instruct",
    engine: "Instruction-tuned, served via HuggingFace transformers",
  },
  {
    value: "smollm2-360m-instruct",
    label: "SmolLM2-360M-Instruct",
    engine: "Instruction-tuned, served via HuggingFace transformers",
  },
];

const MID_CONVERSATION_NOTE =
  "Changing the model mid-conversation reloads the engine, so the next reply's first token takes longer to appear.";

// Find the nearest ancestor that actually clips content, so the menu can
// measure the room it really has (a scrolling settings column, the app shell,
// or the viewport itself).
function clippingAncestor(el) {
  let node = el.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflow;
    if (overflow !== "visible" && overflow !== "clip") return node;
    node = node.parentElement;
  }
  return null;
}

export default function ModelPicker({ value, onChange, disabled = false }) {
  const { activeConversation } = useChat();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Align the menu to the trigger edge that has room for it: a trigger near
  // the right edge of a narrow column (settings) must not spill past the
  // column's clip boundary, while a left-anchored trigger (top bar) stays
  // left-aligned.
  useEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!open || !menu || !root) return;
    const rootRect = root.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const clip = clippingAncestor(root);
    const clipRect = clip
      ? clip.getBoundingClientRect()
      : { left: 0, right: window.innerWidth };
    const spaceRight = clipRect.right - rootRect.left;
    const spaceLeft = rootRect.right - clipRect.left;
    const alignRight = spaceRight < menuWidth && spaceLeft >= menuWidth;
    menu.style.left = alignRight ? "auto" : "0px";
    menu.style.right = alignRight ? "0px" : "auto";
  }, [open]);

  const midConversation = (activeConversation?.messages?.length ?? 0) > 0;
  const current = MODEL_OPTIONS.find((o) => o.value === value);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
      >
        <span className="model-picker-label">{current?.label ?? value}</span>
        <ChevronDownIcon size={14} />
      </button>

      {open && (
        <div className="model-picker-menu" role="listbox" aria-label="Choose a model" ref={menuRef}>
          {MODEL_OPTIONS.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`model-option${selected ? " selected" : ""}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className="model-option-name">{opt.label}</span>
                <span className="model-option-engine">{opt.engine}</span>
                {selected && <CheckIcon size={14} className="model-option-check" />}
              </button>
            );
          })}
          {midConversation && <p className="model-picker-note">{MID_CONVERSATION_NOTE}</p>}
        </div>
      )}
    </div>
  );
}
