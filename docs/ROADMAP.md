# achat roadmap

Build path for taking the self-trained GPT-2 from a training script to a multi-user
ChatGPT-style webapp. Phased so each layer is testable before the next stacks on top.

## Current phase

**Phase 3 — auth (password auth done, Google OAuth outstanding)**
**Phase 4 — frontend rewire (done, see below)**

Phases 0-2 are done: Postgres up (Docker, Postgres 18.4), `conversations` table +
CRUD routes, `/generate` loads history from Postgres and persists new turns after
streaming (see `_tracked_generate_events` in `backend/app/app.py`). Phase 3's
`users` table, password signup/login/logout/me (JWT cookie, bcrypt), and
ownership checks on every conversation/generate/stop route are built and tested
(cross-user access correctly 404s). Frontend has a real login/signup screen
(`AuthScreen.jsx`, `AuthContext.jsx`) gating the chat UI.

**Outstanding in Phase 3: Google OAuth.** `/auth/google/login` and
`/auth/google/callback` are not yet built -- the frontend's "Continue with
Google" button links to `/auth/google/login`, which currently 404s. Needs a
Google Cloud Console OAuth client (manual, non-code setup: consent screen +
Web application credentials + `http://localhost:8010/auth/google/callback`
registered as an authorized redirect URI) before the routes are testable.
Design already decided (see Phase 3 section below): backend-driven
authorization-code flow, hand-rolled via `httpx`, no `authlib`.

## Build phases

### Phase 0 — Postgres up (done)
DB running, credentials resolve, clean slate.

### Phase 1 — schema + CRUD, no model
`conversations` table (id, title, messages JSONB, created_at, updated_at). Endpoints:
create / list / fetch / append-message. Prove storage round-trips via curl before any
model involvement.

### Phase 2 — wire model generation into send-message
On append: load conversation history → reconstruct a single prompt string → call
`model.generate` → save assistant reply as a new message in the JSONB array. This is
where the GPT-2 prompt-formatting problem lives (base model, no chat fine-tune).

### Phase 3 — auth
Add `users` table, signup/login (JWT + bcrypt), scope every conversation to a user.
Deliberately after Phase 1-2: don't build persistence infrastructure for a chat that
doesn't chat yet.

**Done:** `users` table (email/name/password nullable/google_id/auth_provider),
`conversations.user_id` FK. Password hashing via `passlib[bcrypt]` (pinned
`bcrypt<4` -- passlib 1.7.4 breaks against bcrypt's `__about__` removal in 4.x).
JWT via `PyJWT`, HS256, single access-token cookie (httpOnly, SameSite=Lax, 7 day
expiry), **no refresh-token rotation** -- deliberate scope cut, not a gap: a
single-demo-account portfolio app doesn't have the long-lived-session threat
model refresh rotation defends against. `get_current_user` dependency in
`backend/app/auth.py`. Routes: `POST /auth/signup`, `POST /auth/login`,
`POST /auth/logout`, `GET /auth/me`. Every conversation-touching route
(`/generate`, `/stop`, all `/conversations/*` including the added
`DELETE /conversations/{id}`) is ownership-checked -- mismatched/missing
ownership returns 404, not 403, so a request can't distinguish "doesn't exist"
from "exists but isn't yours." `CORSMiddleware` needs `allow_credentials=True`
and every frontend `fetch` needs `credentials: "include"` for the cookie to
survive the :5173/:8010 origin split in dev -- easy to forget on a new fetch call.

**Outstanding: Google OAuth.** Backend-driven authorization-code flow (not a
frontend Google SDK popup) -- `GET /auth/google/login` redirects to Google's
consent screen; `GET /auth/google/callback?code=...` exchanges the code
server-to-server via `httpx` (`POST https://oauth2.googleapis.com/token`),
verifies the ID token / calls userinfo, finds-or-creates a `User` (auto-link on
matching verified email if a local-password account already exists with that
email), issues the same JWT cookie as password login, redirects to `/`. Prereq:
Google Cloud Console OAuth client (Web application, redirect URI
`http://localhost:8010/auth/google/callback` for dev, the HF Spaces URL added
later for prod) -- manual account setup, not code. Client ID is safe to
reference client-side; client secret goes in `.env` alongside `JWT_SECRET`.

**Explicitly out of scope** (deliberate cuts, not gaps -- each would need new
infra, like email sending, to defend against a threat model a single-demo-account
portfolio app doesn't have): password reset flow, email verification, multi-device
session revocation, login rate-limiting.

### Phase 4 — frontend rewire (Claude writes)
Swap React from local mock state to the real conversation_id-based API.

**Done:** restyled to the `design idea/` mockup's system (warm palette, 2px
dividers, accent-coloured live metrics). Router-based (`react-router-dom`) with
three routes: chat (`/`), searchable history table (`/history`), settings
(`/settings`). Persistent top bar carries the model picker, live tok/s, KV cache
segmented control, and peak memory. 56px icon rail for navigation, plus a
collapsible conversation panel (collapse state persisted in `localStorage`).
Conversations can be renamed inline (`PATCH /conversations/{id}`, optimistic with
revert-on-failure) and deleted from both the panel and the history table.

**Deviation from the mockup:** the model dropdown lives in the top bar, not only
in settings -- switching models is a per-message action, not a configuration one.

### Phase 4.5 — auto-generated chat titles
Conversations are currently titled by client-side truncation of the first user
message (`deriveTitle` in `ChatContext.jsx`), with manual rename as the escape
hatch. Replace with a real generated title: after the first exchange completes,
ask a model to summarise it into a short title and `PATCH` it in. Open questions
worth deciding when this gets built: which model does the summarising (the cheap
instruct models are a better fit than base GPT-2, which won't follow a
"summarise this in 5 words" instruction), whether it runs inline in the
`/generate` request or as a follow-up call, and whether a user's manual rename
should pin the title against later regeneration.

### Phase 5 — context window management
GPT-2's 1024-token window fills fast. Sliding window, summarization, or retrieval of
relevant past turns. The real "memory management" problem. Most interesting phase.

## Future-state: production scaling (documented, NOT built yet)

The architecture below is what a service like ChatGPT actually runs at scale. It is
captured here for understanding and for the portfolio writeup. It should only be built
when access patterns force it — none of it is justified at single-user prototype scale.

### Redis — caching layer
Sit Redis in front of Postgres for hot-conversation reads. Caches the assembled message
history so a user's active conversation loads without hitting the DB on every turn.
**Trigger to build:** measured latency on history-load under concurrent load, or session
data that changes constantly and needs sub-ms reads. At prototype scale, reading one
conversation's JSONB row from Postgres is already fast enough. Cache invalidation (write
invalidates the cached copy) is the hard part you'd only take on once there's a payoff.

### Dedicated document DB (Cosmos DB / MongoDB) — if/when Postgres JSONB tops out
Postgres JSONB covers the document-store pattern fine until you have very large documents,
heavy write concurrency on the same conversation, or need horizontal sharding across
regions. At that point a purpose-built document DB (with its own replication/sharding)
replaces the JSONB-on-one-Postgres-instance approach. **Trigger:** single-row write
contention on hot conversations, or documents growing past what one Postgres row handles
well.

### Read replicas / relational split
Postgres stays the relational backbone for users, auth, billing, metadata. Heavy read
traffic (listing conversations, analytics) goes to read replicas so the primary isn't
saturated by the model-serving write path.

### The principle, not the checklist
Match the data tool to the access pattern:
- conversation threads → document model (read whole thread at once)
- hot/active data → cache (Redis) for low-latency reads
- structured/relational data (users, auth) → relational DB
Don't add a database until a specific access pattern demands it. One Postgres instance
playing all three roles is correct at this scale.
