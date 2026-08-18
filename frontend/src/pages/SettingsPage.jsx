import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../context/ChatContext";
import { useTheme } from "../context/ThemeContext";

const MODEL_OPTIONS = [
  { value: "gpt2", label: "GPT-2 (my KV-cache engine)" },
  { value: "qwen2.5-0.5b-instruct", label: "Qwen2.5-0.5B-Instruct" },
  { value: "smollm2-360m-instruct", label: "SmolLM2-360M-Instruct" },
];

const MAX_NEW_TOKENS_CAP = 512;

const SECTIONS = ["General", "Performance", "Appearance", "Account"];

export default function SettingsPage() {
  const [section, setSection] = useState("Performance");
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const {
    modelName,
    setModelName,
    useCache,
    setUseCache,
    maxNewTokens,
    setMaxNewTokens,
    streaming,
  } = useChat();

  const cacheApplicable = modelName === "gpt2";

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className={section === s ? "active" : ""}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </nav>

      {section === "General" && (
        <div className="settings-content">
          <div>
            <h2>General</h2>
            <p className="settings-intro">Which model answers your messages.</p>
          </div>
          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">Model</div>
              <div className="setting-desc">
                GPT-2 runs on my own KV-cache engine. The instruction-tuned models are served
                via HuggingFace transformers and actually follow instructions. Also switchable
                from the top bar.
              </div>
            </div>
            <select
              className="input"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              disabled={streaming !== null}
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {section === "Performance" && (
        <div className="settings-content">
          <div>
            <h2>Performance</h2>
            <p className="settings-intro">Controls for how achat manages speed and memory.</p>
          </div>

          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">KV cache</div>
              <div className="setting-desc">
                Reuse attention state across turns for faster follow-up replies. Uses more
                memory per session. Only applies to GPT-2 — the HuggingFace models manage
                their own cache.
              </div>
            </div>
            <div className="seg" role="radiogroup" aria-label="KV cache">
              <label className="seg-opt">
                <input
                  type="radio"
                  name="settings-kv"
                  checked={cacheApplicable && useCache}
                  disabled={!cacheApplicable || streaming !== null}
                  onChange={() => setUseCache(true)}
                />
                On
              </label>
              <label className="seg-opt">
                <input
                  type="radio"
                  name="settings-kv"
                  checked={cacheApplicable && !useCache}
                  disabled={!cacheApplicable || streaming !== null}
                  onChange={() => setUseCache(false)}
                />
                Off
              </label>
            </div>
          </div>

          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">Max new tokens</div>
              <div className="setting-desc">
                How long a reply can run before it's cut off. Capped at {MAX_NEW_TOKENS_CAP} so a
                single request can't monopolise the free CPU tier.
              </div>
            </div>
            <input
              type="number"
              className="input"
              style={{ width: 90 }}
              min={16}
              max={MAX_NEW_TOKENS_CAP}
              step={16}
              value={maxNewTokens}
              disabled={streaming !== null}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isNaN(next)) return;
                setMaxNewTokens(Math.min(Math.max(next, 16), MAX_NEW_TOKENS_CAP));
              }}
            />
          </div>

          <hr className="hr" />
          <div className="setting-placeholder">
            <div>More performance controls land here as they ship.</div>
            <button type="button" className="btn btn-ghost" disabled>+ Add metric</button>
          </div>
        </div>
      )}

      {section === "Appearance" && (
        <div className="settings-content">
          <div>
            <h2>Appearance</h2>
            <p className="settings-intro">How achat looks.</p>
          </div>
          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">Theme</div>
              <div className="setting-desc">
                Defaults to your system preference on first visit, then remembers your
                choice. Also switchable from the icon rail.
              </div>
            </div>
            <div className="seg" role="radiogroup" aria-label="Theme">
              <label className="seg-opt">
                <input
                  type="radio"
                  name="settings-theme"
                  checked={theme === "light"}
                  onChange={() => theme !== "light" && toggleTheme()}
                />
                Light
              </label>
              <label className="seg-opt">
                <input
                  type="radio"
                  name="settings-theme"
                  checked={theme === "dark"}
                  onChange={() => theme !== "dark" && toggleTheme()}
                />
                Dark
              </label>
            </div>
          </div>
        </div>
      )}

      {section === "Account" && (
        <div className="settings-content">
          <div>
            <h2>Account</h2>
            <p className="settings-intro">You're signed in as {user?.email}.</p>
          </div>
          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">{user?.name}</div>
              <div className="setting-desc">{user?.email}</div>
            </div>
            <button type="button" className="btn btn-ghost" onClick={logout}>Log out</button>
          </div>
        </div>
      )}
    </div>
  );
}
