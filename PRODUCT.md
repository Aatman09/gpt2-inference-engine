# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

General end users chatting with the model — the chat experience itself is the point, not a specific evaluator persona. The interface must hold up as an ordinary chat product first.

## Product Purpose

achat is a multi-user ChatGPT-style webapp serving a GPT-2 language model that was trained from scratch (on FineWeb + Shakespeare) and is served through a hand-written KV-cache inference engine. Success means a visitor can chat with the model and, if they choose to look, can see and understand the live proof that the custom-built inference engine works (toggleable cache, live tok/s, before/after delta).

## Positioning

Everything in the pipeline is hand-built, not assembled from managed services: the model was trained from scratch (not a wrapped third-party API), and the inference engine — including the KV cache — was written and benchmarked by hand rather than using an existing serving framework (vLLM/TGI/etc.). The product is the engineering; the chat UI is where that engineering becomes visible and provable, not just a skin over someone else's model.

## Operating Context

- React 19 SPA (`frontend/`, `react-router-dom`) talking to a FastAPI backend (`backend/`) over a streaming `/generate` endpoint.
- Three routes: chat (`/`), searchable conversation history (`/history`), settings (`/settings`); persistent top bar carries model picker, live tok/s, KV-cache toggle, peak memory.
- Auth: email/password (JWT cookie) and Google OAuth (backend-driven authorization-code flow); a single-demo-account portfolio app's threat model, deliberately without refresh-token rotation, password reset, or rate-limiting.
- Currently single-process/single-user scale (Postgres, no queue/batching); a documented-but-not-built future architecture (separate inference tier, scheduler, continuous batching, paged KV cache) exists in `docs/ROADMAP.md` for when access patterns justify it.
- GPT-2's 1024-token context window is a real, currently-unmanaged constraint (Phase 5, not yet built).

## Capabilities and Constraints

- Live streaming generation with per-token tok/s, KV-cache on/off toggle (GPT-2 engine only — HF-backed models ignore the flag), peak-memory readout, and a session-local cached-vs-uncached speed delta.
- Conversation CRUD: create, list, rename (inline, optimistic with revert-on-failure), delete — from both the conversation panel and the history table. Titles are currently derived by client-side truncation of the first message (`deriveTitle`); real generated titles are a planned but unbuilt phase (4.5).
- Model picker is a per-message action in the top bar, not a settings-only configuration — a deliberate deviation from the original mockup.
- Theming: dark (default) and light, plus a body/heading font choice (system / serif / mono) under Settings > Appearance.
- Known open gap (from prior critique, 2026-08-18): conversation delete is instant and irreversible with no confirm/undo; row actions are hover-only and keyboard/touch-unreachable; several failure paths are console-only with no user-facing retry.

## Brand Commitments

No fixed identity constraints. The name "achat" and current warm-dark palette are the incumbent visual world (ported from a mockup, see `frontend/src/index.css`), not a locked brand — future design work is free to propose a bolder or more consumer-facing voice/visual direction rather than staying low-key/technical by default.

## Evidence on Hand

- `README.md` — from-scratch GPT-2 + custom KV-cache engine, technical explanation of the caching mechanism.
- `docs/ROADMAP.md` — phased build history (Postgres → CRUD → model wiring → auth → frontend rewire), what's done vs. planned, and the documented (not-yet-built) production-scale architecture.
- `docs/UI_ROADMAP.md` — small open frontend-polish backlog (e.g. a proposed grid-hover effect on buttons, details unconfirmed).
- `.impeccable/critique/2026-08-18T14-02-55Z__frontend-src-pages-chatpage-jsx.md` — prior design critique (score 24/40); P1s are instant irreversible delete and the top bar under-weighting the KV-cache toggle relative to the stat it drives.
- No testimonials, case studies, press, pricing, or deployment claims exist; none should be fabricated. Deployment target is Hugging Face Spaces (`README_SPACE.md`, env secrets referenced in `docs/ROADMAP.md`) but is not yet live in production.

## Product Principles

1. The engineering is the product — design should make the hand-built inference engine (training, KV cache, live performance) legible and provable, not decorative.
2. Impossible states stay structurally prevented (e.g. cache toggle gated to the engine that supports it, controls disabled mid-stream) rather than caught after the fact.
3. This is a single-demo-account portfolio app, not a multi-tenant SaaS — security and infra scope cuts (no refresh rotation, no rate-limiting, single Postgres instance) are deliberate and documented, not gaps to silently "fix."
4. Prefer real, working functionality over placeholder affordances — no shipped dead controls (e.g. the existing "+ Add metric" placeholder is a known exception to clean up, not a pattern to repeat).
5. Preserve the KV-cache proof mechanism (toggle, baseline, delta, live tok/s) through any redesign — its legibility and prominence can be improved, but the mechanism itself must survive.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established beyond ordinary web accessibility practice. Known current gap (from prior critique): hover-only conversation actions are unreachable by keyboard/touch, and no `:focus-visible` styling exists on buttons or rail links — worth addressing in future audit/harden work but not yet a stated requirement.
