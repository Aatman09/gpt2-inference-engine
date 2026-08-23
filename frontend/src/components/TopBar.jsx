import { useEffect, useRef, useState } from "react";
import { useChat } from "../context/ChatContext";
import ModelPicker from "./ModelPicker";
import Switch from "./Switch";
import { MenuIcon, MoreIcon } from "./icons";

const KV_CACHE_HELP =
  "Reuses attention state across turns, so each new token costs one forward pass instead of a full recompute.";

export default function TopBar() {
  const { metrics, useCache, setUseCache, modelName, setModelName, streaming, togglePanel } =
    useChat();
  const [engineOpen, setEngineOpen] = useState(false);
  const engineRef = useRef(null);

  // the cache toggle is only a real code path on the GPT-2 engine
  // (supports_cache_toggle=True) -- the HF-backed models ignore the flag
  const cacheApplicable = modelName === "gpt2";

  // click-outside-to-close, matching ModelPicker's own pattern -- keeps the
  // two dropdown-shaped controls in the top bar behaving identically
  useEffect(() => {
    if (!engineOpen) return;
    const onPointerDown = (e) => {
      if (engineRef.current && !engineRef.current.contains(e.target)) setEngineOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setEngineOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [engineOpen]);

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
      <button
        type="button"
        className="icon-btn"
        onClick={togglePanel}
        aria-label="Open menu"
        title="Open menu"
      >
        <MenuIcon />
      </button>

      {/* the model name IS the title, as in the reference -- one slot doing
          both jobs instead of a brand wordmark and a separate picker */}
      <div className="top-bar-model">
        <ModelPicker value={modelName} onChange={setModelName} disabled={streaming !== null} />
      </div>

      {/* everything the engine exposes -- KV-cache switch, live tok/s, cache
          delta, peak memory -- lives behind this overflow. It used to sit
          permanently expanded across the bar, competing with the model name
          and the chat itself; the proof is one tap away, not on every pixel. */}
      <div className="top-bar-engine" ref={engineRef}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setEngineOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={engineOpen}
          aria-label="Engine metrics"
          title="KV cache, tokens/sec and memory"
        >
          <MoreIcon />
        </button>

        {engineOpen && (
          <div className="top-bar-engine-menu" role="group" aria-label="Engine metrics">
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

            <hr className="hr" />

            <div className="top-bar-stat">
              <span className="top-bar-stat-value">{lastRate === null ? "—" : lastRate.toFixed(0)}</span>
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

            {metrics?.peak_memory_mb !== undefined && (
              <div className="top-bar-stat">
                <span className="top-bar-stat-value">{metrics.peak_memory_mb.toFixed(0)}</span>
                <span className="top-bar-stat-label">MB peak</span>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
