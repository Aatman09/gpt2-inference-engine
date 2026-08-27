# cachegpt — what was actually built

One document, whole project, written so every claim in it is something you
can open the file and defend line-by-line in an interview. Nothing here is
aspirational — the "not built" section at the end is as important as the
rest. Repo: `github.com/Aatman09/gpt2-inference-engine`. Live:
`https://cachegpt.duckdns.org`.

**Naming:** the product is "cachegpt" — that's what the deployed app, the
domain, and every user-facing string say. "achat" is the internal dev name
still used for the local directory, code comments, and working docs; it
predates the cachegpt branding and was never renamed at the code level on
purpose, so it doesn't show up anywhere a user or recruiter actually looks.

---

## The one-paragraph version

A GPT-2 inference playground with a hand-written KV-cache serving engine,
finetuned with a self-implemented LoRA adapter, deployed live behind a real
domain with TLS on a CPU-only AWS box. Full-stack: FastAPI + async
SQLAlchemy/Postgres backend, React frontend, JWT + hand-rolled Google OAuth
auth, SSE token streaming, Docker deploy with a CPU/GPU build split. The
serving layer treats three different backends (a hand-written engine and two
HuggingFace models) as interchangeable through one interface, so switching
models, toggling the KV cache, and swapping LoRA adapters are all the same
kind of operation to the rest of the system.

---

## 1. The engine layer — the actual centerpiece

### `model_kv.py` — GPT-2 from scratch, with KV caching

A from-scratch GPT-2 (`GPTConfig`, `CausalSelfAttention`, `MLP`, `Block`,
`GPT`) in plain PyTorch, not built on HuggingFace's model code. Loads real
GPT-2 checkpoints via `GPT.from_pretrained`, which copies weights out of
`transformers.GPT2LMHeadModel` — including the row-by-row plumbing needed
because HuggingFace's GPT-2 stores its linear layers as `Conv1D` (weight
shape `(in, out)`) where this implementation uses plain `nn.Linear` (weight
shape `(out, in)`) — every `c_attn`/`c_proj`/`c_fc` weight gets transposed on
load to match.

**The KV cache itself:** each `CausalSelfAttention.forward` accepts an
optional `(past_k, past_v)` pair and returns the concatenated cache
alongside its output. On the decode path, one new token's K/V gets appended
to the running cache instead of recomputing attention over the whole
sequence at every step — the difference between O(n) work per generated
token and O(n²) total. `is_causal` is computed dynamically
(`q.shape[2] == k.shape[2]`) so the same forward pass is correct for both a
multi-token prefill and a single-token decode step without a separate code
path for each.

**A real, non-obvious bug found and fixed in this codebase (not
hypothetical):** `vocab_size` is padded to 50304 (a multiple of 64, for
tensor-core alignment) while the real GPT-2 vocabulary is 50257 — so
`lm_head` has 47 rows that are never trained, left at random init.
Generation already masked them out before sampling, but the **loss
computation didn't**, and cross-entropy over the full padded vocab put loss
at 77 where it should be ~2.5 (measured directly, cross-checked against
HuggingFace's own model on identical input). Pretraining self-corrected this
silently because `lm_head` was trainable; it became a hard blocker the
moment LoRA finetuning froze `lm_head` and the noise could no longer be
trained away. Fixed by slicing logits to `real_vocab_size` before computing
loss — one of the concrete "walked into a wall, diagnosed it, fixed it"
stories this project is meant to produce.

### `Engine` ABC — model-agnostic serving

`backend/app/engine/base.py` defines one interface —
`stream(params: GenerationParams) -> Iterator[str]` — that every backend
implements identically:

- **`GPTKVEngine`** (`gpt_kv.py`) wraps `model_kv.GPT`. Renders chat history
  into GPT-2's flat text format (no chat template exists for base GPT-2),
  encodes with `tiktoken`, and implements `use_cache` as two genuinely
  different code paths — the cached path decodes one token at a time
  against a running KV cache; the naive path (`use_cache=False`) re-runs the
  full forward pass over the whole sequence-so-far on every step, so the
  toggle is a real algorithmic difference the metrics panel can show, not a
  flag that's silently ignored.
- **`HFEngine`** (`hfengine.py`) wraps `transformers` models directly —
  `Qwen/Qwen3.5-0.8B` and `HuggingFaceTB/SmolLM2-360M-Instruct` — behind
  the same `stream()` contract. Qwen3.5 loads at `dtype=bfloat16` (~1.7GB,
  its checkpoint's native dtype) and is not a plain causal LM: its real
  class, `Qwen3_5ForConditionalGeneration`, isn't in
  `AutoModelForCausalLM`'s supported mapping at all -- it's a
  vision-language model, loaded here via `AutoModelForImageTextToText` and
  used text-only, which its own chat template supports natively (verified
  end-to-end, no image input needed). `ibm-granite/granite-4.0-1b` was
  tried as the second HF model and reverted after it OOM-killed the
  deployed container: correct output, but ~1.63B params is ~3.26GB even
  at bf16, and `gpt2-medium` alone already measured ~3.3GB peak on the
  4GB deploy box -- no configuration of that pairing fits.
- **`EngineRegistry`** (`registry.py`) is the single model-name → engine
  lookup. GPT-2 is eager-loaded at startup; the two HF models lazy-load on
  first request and stay cached, so the CPU-only deploy box never pays the
  load cost for a model nobody asked for in a given session.

The interview-relevant point: `app.py`'s `/generate` route depends only on
the `Engine` interface. It has no idea whether it's talking to a
hand-written attention implementation or a full `transformers` model
underneath — that's the actual design decision here, not the individual
model wrappers.

---

## 2. LoRA finetuning — self-implemented, on both a hand-rolled and a
   library path

Full detail (bug-by-bug) is in `docs/PROBLEMS.md` and `docs/FINETUNE.md`; this is the
summary that belongs on a CV.

- **Built the LoRA algorithm from scratch first**: `LoRALinear` wrapping a
  frozen `nn.Linear`, `A` random / `B` zero-initialized (so the adapted
  model is bit-identical to base at step 0 — the property that makes LoRA
  converge instead of starting from injected noise), forward computed as two
  skinny matmuls (`(..., in) → (..., r) → (..., out)`) rather than ever
  materializing the full-rank `ΔW`. Verified with a 24-assertion test suite
  (`training/full/verify_lora.py`) covering injection targeting, parameter
  freezing, bit-identical-at-init, a non-zero-`B`-must-change-output check
  (the check a silently-broken "does nothing" adapter would otherwise still
  pass), disable-restores-base-exactly, and a save/load round-trip.
- **Then re-implemented on `peft`**, deliberately — the standard tooling is
  what's actually used in the field, and the same 24-check suite was ported
  to confirm the swap didn't change behavior. Independently rediscovered the
  same subtle bug in peft's own injection (leaves LoRA wrappers in train
  mode after injecting into an eval'd model, silently keeping dropout live
  at inference) that the hand-rolled version had already hit and fixed —
  evidence the understanding transferred, not just the code.
- **Wrote the data pipeline**: `databricks-dolly-15k`, single flat prompt
  format (`User: ...\nAssistant:...<|endoftext|>`) shared between training
  and serving via one module (`prompt_format.py`) so the two can't drift
  apart, response-only loss masking via `-100`/`ignore_index`, boundary
  correctness verified (`encode(prompt) + encode(response) ==
  encode(prompt + response)` — checked, not assumed, since a BPE merge
  across that seam would silently misalign the mask).
- **Measured before committing to a model size**, rather than guessing: VRAM
  probed directly on the training GPU (RTX 4050, 6GB) across `gpt2`,
  `gpt2-medium`, and `gpt2-large`/`gpt2-xl` (the latter ruled out by
  arithmetic — 1.6B params at fp32 exceeds total VRAM before a run is even
  attempted). Landed on `gpt2-medium` (406M) with bf16 autocast, after
  measuring CPU bf16 autocast to be ~40× *slower* than fp32 on this hardware
  and gating it CUDA-only.
- **Result**: a 4.7MB LoRA adapter (1.18M trainable params against 406M
  frozen — 0.29%) that turns a base language model that never stops talking
  into one that answers a question and emits `<|endoftext|>` reliably —
  verified live: "What is the capital of France?" → "Paris is the capital
  of France." (small GPT-2's adapter, for comparison, answered "Saint-Denis"
  — a real illustration of instruction tuning changing output shape without
  adding facts a small model never had).
- **Found a real limitation post-deploy, not swept under the rug**: the
  adapter free-associates from unrelated prior conversation turns (asking
  about India, then "why is the sky blue" pulled in "the Indian national
  flag") — root-caused to 100% single-turn training data, reproduced
  systematically (1-in-6 seeds with contaminating history vs. 0-in-6
  without, same question), and documented with a concrete fix plan in
  `docs/PROBLEMS.md` rather than hidden.

---

## 3. Streaming architecture

`_generate_events` (`app.py`) is a synchronous generator — each `next()`
call runs a full model forward pass, which is CPU-bound. Calling it directly
from an async route would block the event loop for the entire generation,
stalling every other request. Instead it runs on a worker thread
(`loop.run_in_executor`) and hands tokens back to the async side through an
`asyncio.Queue`, so the event loop stays free to flush each SSE frame as
it's produced rather than batching them up. Per-token metrics (time-to-
first-token, running tokens/sec, peak memory) are computed live in the same
loop and streamed alongside the text, then persisted into the conversation's
JSONB row so a reload shows the same numbers the live reply showed — not
just held in browser memory for one session.

Cancellation: a `threading.Event` per in-flight generation
(`GenerationParams.stop_event`), checked every decode-loop iteration in the
engine, so a stop button actually frees CPU mid-generation instead of
running to `max_new_tokens` regardless — necessary on a free/cheap CPU tier
where a phantom generation nobody's reading burns real, metered compute.

---

## 4. Persistence and auth

- **Postgres (Neon, managed) via SQLAlchemy 2.0 async + Alembic**, migrations
  run automatically at container start (`alembic upgrade head`, a no-op when
  already current). Conversations store messages as a JSONB document
  (`[{"role", "content", "metrics"?}, ...]`) rather than a normalized
  messages table — a deliberate schema choice for a chat app where the unit
  of access is always "the whole conversation," not individual messages.
- **JWT auth** (PyJWT, HS256) in an httpOnly, `SameSite=Lax` cookie;
  passwords via `passlib[bcrypt]`.
- **Google OAuth, hand-rolled with `httpx`** — no `authlib`. Authorization-
  code flow built directly: redirect to Google's consent screen with a
  CSRF `state` token (`secrets.token_urlsafe(32)`, compared with
  `secrets.compare_digest` — constant-time, so response timing can't leak
  whether a guess was close), server-to-server code exchange, userinfo
  fetch, find-or-create by Google's stable subject id (not by email — an
  email match would let an attacker take over an existing local-password
  account by signing up with the victim's address on Google; only linking
  on a Google-verified email, checked explicitly, closes that). The state
  token's cookie is deliberately `SameSite=Lax`, not `Strict` — the OAuth
  callback arrives as a cross-site navigation from `accounts.google.com`,
  and a `Strict` cookie wouldn't be sent on it, breaking the exact check it
  exists to perform.

---

## 5. Frontend

React + Vite. Not the focus of interview prep (per the project's own
framing — the serving/auth/streaming layer is what's meant to hold up under
questioning), but real, working, and iterated hard on mobile:
- SSE consumed via `fetch` + `ReadableStream`, streamed into state token by
  token.
- A single drawer-based navigation (`ConversationPanel.jsx`) replacing an
  earlier icon-rail-plus-sidebar design, rebuilt to match ChatGPT's mobile
  UX after a direct screenshot comparison — always-visible per-conversation
  action menus (not hover-revealed, which is unreachable by touch),
  bottom-pinned account menu, and a composer that's always rendered
  regardless of load/selection state (an earlier version had two early
  returns that rendered *no composer at all* on a fresh mobile visit — a
  genuine dead end with no way to type, found and fixed).
- A text-size setting that scales a CSS custom-property type ramp rather
  than the whole viewport (`--text-scale`), so larger text fills the layout
  instead of magnifying it.

---

## 6. Deployment

- **Docker, multi-stage**: Node build stage for the frontend, Python/`uv`
  stage for the backend, built SPA copied in and served by FastAPI directly
  in production (no separate static host).
- **CPU/GPU torch split via `uv` extras with `[tool.uv.conflicts]`** — the
  plain PyPI torch wheel bundles CUDA runtime libraries even with no GPU to
  use them; a dedicated `cpu` extra pointed at PyTorch's CPU-only wheel
  index dropped the image from **15.8GB to 2.76GB**. (First attempt at this
  was wrong — an unconditional `[tool.uv.sources]` override collapsed both
  extras onto the CPU index regardless of which was requested; fixed with a
  proper `conflicts` declaration once the bug was caught.)
- **AWS EC2** (t3.medium, 2 vCPU, 4GB RAM, no GPU), Elastic IP, DuckDNS
  subdomain, nginx reverse proxy (`proxy_buffering off` — required for SSE;
  without it nginx batches up the streamed frames and the token-by-token
  effect disappears), Let's Encrypt/certbot for TLS.
- **`deploy.sh`** auto-detects GPU via `nvidia-smi` and picks the matching
  torch build and Docker GPU flag — the same script is meant to run
  unmodified on this CPU box today and a GPU box later, if the pending AWS
  quota increase for GPU instances is ever approved.
- **Real incidents diagnosed and fixed, not just described:**
  - Docker `--env-file` doesn't strip quotes — a quoted `DATABASE_URL` in
    `.env` passed the literal quote characters into the env var, crash-
    looping the container with a SQLAlchemy URL-parse error. Diagnosed by
    running `docker run --rm --env-file ... env | grep DATABASE_URL`
    directly rather than guessing from the stack trace.
  - OOM-killed on a t3.micro (1GB) with no traceback, just "Killed" — root-
    caused by measuring actual RSS locally (`docker stats`, 1.37GB peak)
    rather than guessing at instance sizing, then moving to t3.medium.
  - nginx chicken-and-egg at cert provisioning: the config referenced a
    certificate that didn't exist yet, so nginx wouldn't start, but
    certbot's nginx plugin needs nginx running to issue the cert. Broken by
    starting nginx with a bare default config first, then restoring the
    TLS config after the cert existed.
  - EC2 disk filled mid-deploy (`No space left on device`, torch couldn't
    even extract) on an 8GB root volume — diagnosed with `docker system df`
    (9.5 of 10.44GB in images was reclaimable, stale layers from before the
    2.76GB shrink), freed with `docker system prune -af --volumes`.

---

## 7. Tech stack, as actually used

**Backend:** Python, FastAPI, SQLAlchemy 2.0 (async), Alembic, PyJWT,
`passlib`/bcrypt, `httpx` (hand-rolled OAuth), PyTorch, `tiktoken`,
HuggingFace `transformers`, `peft`, `datasets`, `safetensors`, `uv`.

**Frontend:** React, Vite, `react-router`, `react-markdown`.

**Infra:** Docker (multi-stage), AWS EC2, nginx, Let's Encrypt/certbot,
DuckDNS, Neon (managed Postgres), GitHub (source; Actions workflow written
for CI deploy, not yet wired to real secrets — see below).

---

## What's explicitly NOT built (say this plainly if asked, don't overclaim)

- **Speculative decoding and INT8 quantization** — designed in detail
  (`docs/DIFFERENTIATORS.md`), including real measured numbers on this
  machine (16.8ms/token cached fp32 baseline, 10.5ms/token INT8), but
  **not implemented**. If asked "did you build speculative decoding," the
  honest answer is "designed it, measured the baseline numbers it would
  need to beat, didn't implement it" — not a yes.
- **Continuous batching / a request scheduler / multi-request paged KV
  cache** — documented as explicitly future-state in `docs/ROADMAP.md`,
  not built. `B` (batch dimension) is hardcoded to 1 everywhere in the
  serving path today.
- **Multi-turn LoRA training** — the fix for the context-bleed bug above is
  designed, not implemented.
- **CI/CD via GitHub Actions** — the workflow file and deploy script exist;
  the IAM user and repo secrets to actually wire it up were deliberately
  deferred ("keep doing it manually" was the explicit call). Deploys today
  are `git push` + manual `ssh` + `bash deploy/deploy.sh`.
- **Refresh-token rotation** — single JWT access token, no rotation. A
  documented, deliberate scope cut for a single-demo-account app, not an
  oversight, but worth stating as a cut if asked about production auth
  hardening.

## Known loose ends (small, real, worth knowing about before an interview)

- `backend/app/.env.local-docker.bak` is still git-tracked (old local
  Postgres credentials in a file `.gitignore` doesn't cover — `.bak` isn't
  excluded). Should be removed from version control.
- The Neon database password and the Google OAuth client secret were both
  exposed in a chat session at one point during development; rotation was
  flagged repeatedly and is still outstanding as of this writing.
- `adapters/instruct/` (the small-GPT2 LoRA adapter, superseded by the
  medium one now in production) has no saved config and is currently
  unloadable — harmless since nothing references it, but a loose end.
- EC2's root volume will fill again on a future deploy; no prune step is in
  `deploy.sh` yet.

---

## If you need CV-bullet phrasing

Drafted from the sections above, not invented — check each against the
section it summarizes before using it:

- Built a from-scratch GPT-2 inference engine in PyTorch with a hand-
  written KV cache, serving it behind a model-agnostic interface alongside
  two HuggingFace models, with a live ON/OFF cache toggle exposing a real
  measured throughput difference.
- Implemented LoRA finetuning twice — a from-scratch version (with a
  self-written 24-case correctness suite) and a `peft`-based production
  version — to instruction-tune GPT-2 on the Dolly-15k dataset; found and
  fixed a vocabulary-padding bug in the base model's loss computation that
  silently corrupted LoRA training (loss off by ~30x) but had gone unnoticed
  through years of pretraining because full finetuning could self-correct
  around it and LoRA can't.
- Designed and hand-rolled a Google OAuth authorization-code flow (no
  `authlib`) with CSRF-protected state, constant-time comparison, and
  account-linking restricted to Google-verified emails to close an account-
  takeover path.
- Deployed the full stack (FastAPI, Postgres, React) to a CPU-only AWS EC2
  instance behind nginx and TLS, cutting the Docker image from 15.8GB to
  2.76GB via a CPU/GPU-conditional PyTorch build; diagnosed and fixed real
  production incidents (OOM kills, a quoted-env-var crash loop, an
  nginx/certbot bootstrap deadlock, disk exhaustion) using direct
  measurement (`docker stats`, `docker system df`) rather than guesswork.
