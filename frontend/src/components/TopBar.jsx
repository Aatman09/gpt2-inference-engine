import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useChat } from "../context/ChatContext";
import ModelPicker from "./ModelPicker";
import Switch from "./Switch";
import { MenuIcon } from "./icons";

const KV_CACHE_HELP =
  "Reuses attention state across turns, so each new token costs one forward pass instead of a full recompute.";

export default function TopBar() {
  const { metrics, useCache, setUseCache, modelName, setModelName, streaming, togglePanel } =
    useChat();
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
      <button
        type="button"
        className="icon-btn"
        onClick={togglePanel}
        aria-label="Open menu"
        title="Open menu"
      >
        <MenuIcon />
      </button>

      <NavLink
        to="/chat"
        className="top-bar-brand"
        aria-label="Go to chat"
      >
        cachegpt
      </NavLink>

      <ModelPicker value={modelName} onChange={setModelName} disabled={streaming !== null} />

      <div className="top-bar-spacer" />

      {/* One complete engine cluster: its control, the resulting speed, the
          A/B comparison, and peak memory stay together rather than splitting
          the evidence between a bar and an overflow menu. */}
      <div
        className="top-bar-cache"
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
        <span className="top-bar-rate">
          <span className="top-bar-stat-value">
            {lastRate === null ? "—" : lastRate.toFixed(0)}
          </span>
          <span className="top-bar-stat-label">tok/s</span>
        </span>
        {delta && (
          <span className="tag tag-accent top-bar-delta" title={delta.title}>
            {delta.text}
          </span>
        )}
        {metrics?.peak_memory_mb !== undefined && (
          <span className="top-bar-memory" title="Peak memory used for the last reply">
            {metrics.peak_memory_mb.toFixed(0)} MB
          </span>
        )}
      </div>
    </header>
  );
}
