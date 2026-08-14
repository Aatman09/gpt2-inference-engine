# achat roadmap

Build path for taking the self-trained GPT-2 from a training script to a multi-user
ChatGPT-style webapp. Phased so each layer is testable before the next stacks on top.

## Current phase

**Phase 1 — conversation storage (JSONB document model, in progress)**

Postgres is up (Docker, Postgres 18.4, `postgresql+asyncpg://postgres:1234@localhost:5432/postgres`,
public schema empty). Storing each conversation as a single row with a `messages` JSONB
array — the document-store pattern (the thing ChatGPT does with Cosmos DB), done inside
Postgres so there's no second database to operate.

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

### Phase 4 — frontend rewire (Claude writes)
Swap React from local mock state to the real conversation_id-based API.

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
