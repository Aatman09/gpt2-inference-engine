# achat

A full-stack chat app serving GPT-2 through a hand-written KV-cache inference
engine — trained from scratch, then wrapped in real product infrastructure:
streaming responses, persistent multi-user conversations, authentication, and
a production deploy.

The KV cache is the core of the project. Everything else — the FastAPI
serving layer, Postgres persistence, JWT/Google auth, the React chat UI — was
built to give that engine somewhere real to run.

## What's in here

| Path | What it is |
|---|---|
| `model_kv.py` | GPT-2 with a hand-written KV cache plumbed through attention, Block, and GPT — the core of the project |
| `train.py`, `dataloader2.py` | Pretraining GPT-2 from scratch on FineWeb shards |
| `inference.py`, `inference_kv.py` | Naive vs. cached generation, used to benchmark the cache against the no-cache baseline |
| `backend/` | FastAPI serving layer — see below |
| `frontend/` | React chat UI — see below |
| `deploy/` | EC2 deploy scripts, nginx config, GitHub Actions CI/CD (see `deploy/SETUP.md`) |
| `docs/` | Build roadmap, architecture notes, deploy planning |

## The KV cache, in one paragraph

Naive generation re-runs the full sequence through every transformer block on
every new token: at step `t`, you recompute K and V for all `t` past tokens,
even though they haven't changed. KV caching saves K and V per layer once
they're computed, so each decode step does just one new token's worth of
attention work. Quadratic per-step cost becomes linear.

In `model_kv.py`, the cache is a list of `(k, v)` tensors, one per block:
- On the first call (`kv_caches=None`), the prefill runs as normal and the
  returned `new_kv_caches` are the K/V for every block.
- On each decode call, you pass a single new token plus the cache; each block
  concatenates the new K/V onto the past and returns the updated cache.
- `is_causal=True` only when `q.shape[2] == k.shape[2]` (prefill); during
  decode, the lone query attends to all past keys, no mask needed.
- Position IDs are continued from `past_length` so `wpe` doesn't reset to 0.

## Backend (`backend/`)

FastAPI serving layer, built around a model-agnostic `Engine` interface so
the hand-written KV-cache GPT-2 and off-the-shelf HuggingFace instruct models
(Qwen2.5-0.5B, SmolLM2-360M) are swappable behind one API.

- **Streaming** — `POST /generate` streams tokens over Server-Sent Events,
  with live tokens/sec, time-to-first-token, and peak-memory metrics
  computed per reply. `POST /stop` cancels an in-flight generation.
- **Persistence** — conversations and messages live in Postgres (JSONB
  document-store pattern), scoped per user. Full CRUD under `/conversations`.
- **Auth** — JWT in an `httpOnly` cookie, bcrypt-hashed passwords, plus
  Google OAuth (`/auth/google/login` → `/auth/google/callback`), hand-rolled
  authorization-code flow, no third-party auth library.
- **Ownership isolation** — every conversation/generate/stop route checks
  the authenticated user owns the resource; a mismatch is a 404, not a 403,
  so existence isn't leaked.

See `docs/ROADMAP.md` for the full phased build history and
`docs/DEPLOY_PLAN.md` for how the deploy decisions were made.

## Frontend (`frontend/`)

React SPA — streaming chat UI with markdown rendering, a collapsible
conversation sidebar, live model switching, a KV-cache on/off toggle (to see
the cache's actual speed difference), theme/font/zoom settings, and a
dedicated landing/auth flow in front of the chat.

## Running locally

```bash
# backend
cd backend
uv sync
cp app/.env.example app/.env   # fill in DATABASE_URL, JWT_SECRET
uv run alembic upgrade head
uv run uvicorn app.app:app --reload --port 8010

# frontend
cd frontend
npm install
npm run dev
```

## Deploying

See `deploy/SETUP.md` for the full EC2 GPU deploy — single Docker container
(FastAPI serves the built React app), nginx reverse proxy with Let's
Encrypt, GitHub Actions auto-deploy on push to `main`.
