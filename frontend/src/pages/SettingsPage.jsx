import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../context/ChatContext";
import { useTheme } from "../context/ThemeContext";
import ModelPicker from "../components/ModelPicker";
import Switch from "../components/Switch";

const MAX_NEW_TOKENS_CAP = 512;

const SECTIONS = ["General", "Performance", "Appearance", "Account"];

export default function SettingsPage() {
  const [section, setSection] = useState("Performance");
  const { user, logout } = useAuth();
  const { theme, toggleTheme, font, setFont, zoom, setZoom } = useTheme();
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
            <ModelPicker value={modelName} onChange={setModelName} disabled={streaming !== null} />
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
            <Switch
              checked={cacheApplicable && useCache}
              onChange={setUseCache}
              disabled={!cacheApplicable || streaming !== null}
              label="KV cache"
            />
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
              <div className="setting-label">Dark mode</div>
              <div className="setting-desc">
                Defaults to your system preference on first visit, then remembers your
                choice. Also available from the account menu.
              </div>
            </div>
            <Switch checked={theme === "dark"} onChange={toggleTheme} label="Dark mode" />
          </div>

          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">Font</div>
              <div className="setting-desc">
                The reading face for messages and the interface. Each option previews
                itself.
              </div>
            </div>
            <div className="choice" role="radiogroup" aria-label="Font">
              <button
                type="button"
                className={`choice-btn${font === "system" ? " active" : ""}`}
                onClick={() => setFont("system")}
              >
                System
              </button>
              <button
                type="button"
                className={`choice-btn font-serif${font === "serif" ? " active" : ""}`}
                onClick={() => setFont("serif")}
              >
                Serif
              </button>
              <button
                type="button"
                className={`choice-btn font-mono${font === "mono" ? " active" : ""}`}
                onClick={() => setFont("mono")}
              >
                Mono
              </button>
            </div>
          </div>

          <hr className="hr" />
          <div className="setting-row">
            <div>
              <div className="setting-label">Text size</div>
              <div className="setting-desc">
                Scales the type, not the whole interface — larger text fills
                the same layout rather than magnifying it. Stored on this device.
              </div>
            </div>
            <div className="choice" role="radiogroup" aria-label="Text size">
              {[90, 100, 110, 125].map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`choice-btn${zoom === level ? " active" : ""}`}
                  onClick={() => setZoom(level)}
                >
                  {level}%
                </button>
              ))}
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
