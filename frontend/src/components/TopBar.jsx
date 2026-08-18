import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useChat } from "../context/ChatContext";

const MODEL_OPTIONS = [
  { value: "gpt2", label: "GPT-2 (my KV-cache engine)" },
  { value: "qwen2.5-0.5b-instruct", label: "Qwen2.5-0.5B-Instruct" },
  { value: "smollm2-360m-instruct", label: "SmolLM2-360M-Instruct" },
];

const KV_CACHE_HELP =
  "Reuses attention state across turns, so each new token costs one forward pass instead of a full recompute.";

export default function TopBar() {
  const { metrics, useCache, setUseCache, modelName, setModelName, streaming } = useChat();

  // the cache toggle is only a real code path on the GPT-2 engine
  // (supports_cache_toggle=True) -- the HF-backed models ignore the flag
  const cacheApplicable = modelName === "gpt2";

  // The backend sends tokens_per_sec on token frames and cache_used only on
  // the final done frame, so neither the live rate nor its cache context
  // survives alone: keep the last rate and the last rate per cache state so
  // the readout persists after a reply finishes, and so a cached vs uncached
  // comparison is possible without holding numbers in memory.
  const [lastRate, setLastRate] = useState(null);
  const [lastByCache, setLastByCache] = useState({ on: null, off: null });

  useEffect(() => {
    if (metrics?.tokens_per_sec !== undefined) setLastRate(metrics.tokens_per_sec);
  }, [metrics]);

  useEffect(() => {
    if (metrics?.cache_used !== undefined && lastRate !== null && lastRate > 0) {
      setLastByCache((prev) => ({
        ...prev,
        [metrics.cache_used ? "on" : "off"]: lastRate,
      }));
    }
    // lastRate is deliberately excluded: only the rate of the generation that
    // just completed should be recorded, and it is already committed by the
    // time the done frame lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics?.cache_used]);

  const cacheState = metrics?.cache_used !== undefined ? (metrics.cache_used ? "on" : "off") : null;

  const delta =
    cacheApplicable && lastByCache.on > 0 && lastByCache.off > 0
      ? lastByCache.on >= lastByCache.off
        ? {
            text: `×${(lastByCache.on / lastByCache.off).toFixed(1)} with cache`,
            title: `Cached replies ran ${(lastByCache.on / lastByCache.off).toFixed(1)}× faster than uncached ones (this session)`,
          }
        : {
            text: `×${(lastByCache.off / lastByCache.on).toFixed(1)} without cache`,
            title: `Uncached replies ran ${(lastByCache.off / lastByCache.on).toFixed(1)}× faster than cached ones (this session)`,
          }
      : null;

  return (
    <header className="top-bar">
      <Link to="/" className="top-bar-brand">achat</Link>

      <select
        className="input top-bar-model"
        value={modelName}
        onChange={(e) => setModelName(e.target.value)}
        disabled={streaming !== null}
        aria-label="Model"
        title="Which model answers your messages"
      >
        {MODEL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      <div className="top-bar-divider" />

      <div
        className="top-bar-control"
        role="radiogroup"
        aria-label="KV cache"
        title={
          cacheApplicable
            ? KV_CACHE_HELP
            : `${KV_CACHE_HELP} Only applies to GPT-2 — the HuggingFace models manage their own cache.`
        }
      >
        <span className="top-bar-stat-label">KV cache</span>
        <div className="seg">
          <label className="seg-opt">
            <input
              type="radio"
              name="kv-cache"
              checked={cacheApplicable && useCache}
              disabled={!cacheApplicable || streaming !== null}
              onChange={() => setUseCache(true)}
            />
            On
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="kv-cache"
              checked={cacheApplicable && !useCache}
              disabled={!cacheApplicable || streaming !== null}
              onChange={() => setUseCache(false)}
            />
            Off
          </label>
        </div>
      </div>

      <div className="top-bar-divider" />

      <div className="top-bar-stat">
        <span
          className="top-bar-stat-value"
          title={
            lastRate === null
              ? "No measurement yet — send a message to watch the engine live"
              : "Tokens per second, measured live"
          }
        >
          {lastRate === null ? "—" : lastRate.toFixed(0)}
        </span>
        <span className="top-bar-stat-meta">
          <span className="top-bar-stat-label">
            tok/s{cacheState ? ` · cache ${cacheState}` : ""}
          </span>
          {delta && (
            <span className="tag tag-accent top-bar-delta" title={delta.title}>
              {delta.text}
            </span>
          )}
        </span>
      </div>

      <div className="top-bar-divider" />

      {metrics?.peak_memory_mb !== undefined && (
        <div className="top-bar-stat">
          <span
            className="top-bar-stat-value"
            title="Peak memory the engine used during the last reply"
          >
            {metrics.peak_memory_mb.toFixed(0)}
          </span>
          <span className="top-bar-stat-label">MB peak</span>
        </div>
      )}
    </header>
  );
}
