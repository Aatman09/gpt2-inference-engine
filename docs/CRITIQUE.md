# Design Critique — achat chat UI

> Method: dual-agent (A: `ses_feb009c60ffeV7N6ul2Db4V0sF` · B: `ses_feb00979cffevtBnbK0S0wecOV`)
> Date: 2026-08-18 · Target: `frontend/src/pages/ChatPage.jsx` · Mode: Operate

## Design Health Score — 24/40, Acceptable

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Blinking cursor + live tok/s are excellent; blank panel during hydration (ChatPage.jsx:32-34), silent session check, ambiguous idle "—" |
| 2 | Match System / Real World | 3 | Warm plain copy; "TTFT", "KV cache", "tok/s", "MB peak" unglossed on the main surface (TopBar.jsx:36-79) |
| 3 | User Control and Freedom | 2 | Stop + Escape-cancel-rename exist; delete is instant, permanent, hover-hidden (ConversationPanel.jsx:90-100) |
| 4 | Consistency and Standards | 3 | Cohesive tokens; rename inline in panel vs `window.prompt()` in History; raw "⏻" glyph among SVG icons (Rail.jsx:81); New chat in three places |
| 5 | Error Prevention | 2 | Controls disabled mid-stream; max-tokens clamps silently; delete unguarded; draft dropped while streaming |
| 6 | Recognition Rather Than Recall | 2 | Icon-only rail; hover-revealed actions are `display:none` (index.css:429-445) → keyboard/touch unreachable; telemetry needs prior knowledge |
| 7 | Flexibility and Efficiency | 3 | Panel collapse, Enter-to-send, optimistic rename; no shortcuts, no A/B compare affordance |
| 8 | Aesthetic and Minimalist Design | 3 | Coherent warm system; top bar crams 3 stats + 2 controls at mixed 11-22px weights; dead "+ Add metric" placeholder ships (SettingsPage.jsx:145-148) |
| 9 | Error Diagnosis and Recovery | 2 | Inline auth error + recovery bubble; list/select/delete failures console-only, no retry |
| 10 | Help and Documentation | 1 | No help, no tooltips on telemetry, no onboarding; settings descriptions are the only engine documentation |

## Design Specificity Verdict

**The data is bespoke, the language is borrowed.** The signature moments — 22px accent tok/s stat, KV-cache seg control, per-message `tok/s · KV cache · TTFT` lines (MessageBubble.jsx:12-30), "Your own GPT-2, served by a hand-written KV-cache engine" (ChatPage.jsx:56), the GPT-2-gated cache toggle (TopBar.jsx:15) — could not survive on an unrelated product. But the shell around them (icon rail, 240px conversation panel, top bar, composer, auth card, warm-dark palette, 2px dividers) is a faithful, generic chatbot-skeleton port. The mockup's language was ported with discipline but doesn't *speak* this product's story — only the telemetry layer does, and it's visually subordinate (12px toggle vs. 22px stat).

**Deterministic scan:** clean — 0 findings (exit 0, valid JSON). No antipattern rules triggered; the meaningful issues here are judgment-level, not rule-level.

**Visual overlays:** not available — no browser automation in this session; static review stands in (fallback signal: no browser tool exposed).

## Overall Impression

The streaming moment is genuinely excellent — this is a chat app that already knows its best scene and plays it well. The gap: the product's identity (a hand-built engine you can watch work) lives only in the top bar, while everything else is a faithful-but-generic chatbot shell. **The single biggest opportunity: make the KV-cache experiment — toggle, baseline, delta — the hero of the surface** instead of a subordinate control. That flips the whole app from "generic chat with telemetry" to "a watchable engine."

## What's Working

1. **The streaming signature moment** — send→stop swap, blinking cursor, live per-token tok/s (ChatPage.jsx:76-96). System-status feedback tuned precisely to this persona.
2. **Context-correct affordances** — model picker and cache toggle disabled mid-stream; cache toggle gated to the GPT-2 engine (TopBar.jsx:15,26,53). Impossible states structurally prevented.
3. **Disciplined design-system port** — explicit dual themes with inverted accent steps for light-theme contrast (index.css:44-50), tabular-nums on every metric, ch-based message width cap (index.css:525), composer and messages share one 1100px measure.

## Priority Issues

1. **[P1] Instant irreversible conversation delete.** Two hover clicks, zero confirmation, no undo (ConversationPanel.jsx:90-100; HistoryPage.jsx:123-131). The conversation list *is* the artifact for the interviewer persona — one misclick erases the demo. **Fix:** confirm dialog or "Deleted — Undo" toast before the DELETE in `removeConversation` (ChatContext.jsx:99-114). → `$impeccable harden`
2. **[P1] The top bar inverts the product's causal story.** The 22px accent tok/s number visually outranks the 12px KV-cache toggle that moves it (TopBar.jsx:36-69); idle "—" is stale-vs-live ambiguous. **Fix:** group model + cache into a bordered engine cluster with a tooltip; show the last turn's rate with its cache state; add a delta ("2.1× with cache") so the correlation is perceivable without memory. → `$impeccable layout`
3. **[P2] Blank screens instead of load states.** Session check returns null (App.jsx:17), hydration renders an empty div (ChatPage.jsx:32-34) — on a demo machine both flash as a dead app. **Fix:** branded splash/skeleton during `/auth/me`; spinner or skeleton rows while hydrating. → `$impeccable onboard`
4. **[P2] Conversation actions unreachable for keyboard and touch.** `.conversation-action` is `display:none` until `:hover` (index.css:429-445) → removed from tab order; no `:focus-visible` styling anywhere (`.btn`, `.rail-link` use transparent borders). **Fix:** `:hover, :focus-within` reveal + visible focus rings. → `$impeccable audit`
5. **[P3] Failures are silent or developer-garbled.** Load/select/delete errors console-only (ChatContext.jsx:69,84,103); the one surfaced error says "Is uvicorn running on port 8010?" (ChatContext.jsx:201). **Fix:** polite "the engine didn't respond — try again" with a retry affordance; dev details stay in the console. → `$impeccable harden`

## Persona Red Flags

**Alex (Power User):** no way to compare runs — the top-bar stat resets to "—" and history's "Last speed"/"KV cache" columns are session-local (HistoryPage.jsx:100-110), silently dropping the data the columns promise; rename in History is a jarring `window.prompt()`; max-new-tokens buried in settings; no shortcuts beyond Enter.

**Sam (Accessibility):** hover-only row actions (keyboard- and touch-invisible); no `:focus-visible` on buttons/rail links; custom radios `opacity:0; position:absolute` (index.css:171-181) with fill-color-only state and no focus ring; streaming text has no `aria-live` announcement; 11px uppercase labels at 55%-alpha muted sit near contrast limits.

**Jordan (First-Timer):** lands on a generic auth card with zero product context ("Welcome back" on first visit — no demo hint, no what-this-is line, AuthScreen.jsx:46-51); then a wall of jargon with no tooltips; rail icons unlabeled until hover; Settings defaults to "Performance" (SettingsPage.jsx:17) — KV-cache and max-tokens before General/Appearance.

**Interviewer mid-conversation (project persona):** the question they're asking — "is the KV cache real?" — requires correlating a 12px seg control with a 22px stat across manual toggles; no baseline, no delta, no before/after framing; per-message metrics mix three unglossed units with dot separators; "KV cache: on" doesn't say *that reply was faster because of it*; history's KV-cache column promises persistence it doesn't have.

## Minor Observations

- Duplicate brand moment: "achat" in top bar *and* as empty-state h2 (ChatPage.jsx:55).
- Composer textarea `rows={1}`, no auto-grow; long drafts scroll internally.
- `loadConversations` auto-creates a chat (ChatContext.jsx:67) — "No chats yet." is dead copy.
- "+ Add metric" dashed placeholder with a disabled button ships to production.
- Error bubble preserves raw stream on stop, labels "(empty response)" if stopped instantly.
- Draft typed while streaming is silently dropped (ChatPage.jsx:38).
- History search filters titles only, not message content. Document title never reflects the active conversation.

## Questions to Consider

1. If the demo's core proof is "watch the KV cache change tok/s," why is the toggle a 12px control subordinate to a 22px number — shouldn't the experiment (toggle, baseline, delta) be the hero?
2. The warm palette and 2px dividers are a faithful port of a stock chatbot mockup — is that system doing identity work for this product, or is it decor any SaaS could wear? What would the UI look like if the *engine* were the brand?
3. A conversation is the only artifact this product produces, and deletion is instant and permanent. If an interviewer's demo conversation is accidentally deleted, does the product currently have any way to earn that trust back?

## Run Notes

Target slug `frontend-src-pages-chatpage-jsx` confirmed · no ignore list · assessments ran isolated in parallel · CLI detector ran clean (0 findings, exit 0) · browser visibility unavailable (no browser tool — fallback signal) · no overlay injection attempted · no live server started · snapshot written to `.impeccable/critique/2026-08-18T14-02-55Z__frontend-src-pages-chatpage-jsx.md`.

**Trend for `frontend-src-pages-chatpage-jsx` (last 5 runs): 24 (out of 40) — first run for this target, no trend yet.**

## Decided Next Steps (user-confirmed)

Priority: engine story (P1 #2) · Scope: top issues only · Tone: keep the incumbent world.

1. **`$impeccable layout`** — Fix the top bar hierarchy: group model picker + KV-cache toggle into a bordered engine cluster, give the cache toggle visual weight equal to the tok/s readout, add the cache-on/off delta framing, resolve the ambiguous idle "—" (P1 #2)
2. **`$impeccable clarify`** — Gloss the telemetry: tooltips on "TTFT", "KV cache", "MB peak", a one-line explanation of what the toggle proves — same engine-story issue, copy half (P1 #2)
3. **`$impeccable polish`** — Final quality pass over the touched top bar and message metrics
