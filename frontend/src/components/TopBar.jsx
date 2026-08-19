import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useChat } from "../context/ChatContext";
import ModelPicker from "./ModelPicker";
import Switch from "./Switch";

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
      <Link to="/chat" className="top-bar-brand">achat</Link>

      <div className="top-bar-model">
        <ModelPicker value={modelName} onChange={setModelName} disabled={streaming !== null} />
      </div>

      <div className="top-bar-divider" />

      <div
        className="top-bar-control"
        title={
          cacheApplicable
            ? KV_CACHE_HELP
            : `${KV_CACHE_HELP} Only applies to GPT-2 — the HuggingFace models manage their own cache.`
        }
      >
        <span className="top-bar-stat-label">KV cache</span>
        <Switch
          checked={cacheApplicable && useCache}
          onChange={setUseCache}
          disabled={!cacheApplicable || streaming !== null}
          label="KV cache"
        />
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
