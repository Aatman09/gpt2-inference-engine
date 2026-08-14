# Continuation Prompt — gpt2-inference-engine → deployed inference playground

*Paste everything below into a fresh session started in `~/dev/achat`.*

---

I'm Aatman Soni, B.Tech CSE (May 2027), currently in campus placement season and applying for AI/ML roles in India. This repo is one of three portfolio projects I'm shipping. My hard rule: **I do not put anything on my CV I cannot defend in an interview** — so I need to genuinely understand what gets built here, not just have it work.

## Where things stand

**Repo:** `~/dev/achat` → `github.com/Aatman09/gpt2-inference-engine` (already renamed; the CV links to this URL).

A related but separate repo exists at `~/dev/inference_benchmark` → `github.com/Aatman09/-gpt2-inference-benchmark` (note the stray leading hyphen in that repo name). It holds `benchmark.py`, `model.py`, `model_kv.py`. Decide early whether to merge its benchmark harness into this repo or keep them separate — I'd rather have one strong repo than two half ones.

**What already exists here:**

- `model_kv.py` (root) — GPT-2 implemented from scratch in PyTorch with a custom KV-cache engine. Classes: `GPTConfig`, `CausalSelfAttention` (its `forward` takes `kv_cache`), `MLP`, `Block`, `GPT`. Key methods: `GPT.forward(idx, kv_caches=None, targets=None)`, `GPT.from_pretrained(model_type)`, `GPT.generate(idx, max_new_tokens, temperature=1.0, top_k=None)`. Handles conditional causal masking (causal at prefill, omitted at single-token decode) and continued position ids through `wpe` so embeddings stay correct across cached steps.
- `training/` — `train.py` (FineWeb pretraining, bf16 autocast, grad accumulation, grad-norm clipping, torch.compile), `dataloader2.py` (sharded loader), `prepare.py`, `inference.py` (naive generation), `inference_kv.py` (cached generation).
- `backend/` — FastAPI app managed by uv, Python ≥3.11. Deps already include `torch`, `transformers`, `tiktoken`, `fastapi`, `uvicorn`, `sqlalchemy`, `asyncpg`. `backend/app/app.py` already imports `model_kv.GPT`, has a `load_model(model_name)` helper, a `my_models` dict for caching loaded models, CORS middleware, and lifespan setup.
- `frontend/` — a Vite app (`package.json`, `vite.config.js`, `src/`, `dist/`).
- `fineweb_shards/` — training data (~540MB; keep out of git).
- `NEXT_IMPLEMENTATION` — a **training-side** GPU optimisation plan (dataloader prefetching, gradient checkpointing, torch.compile max-autotune). This is a *different* direction from the current goal; don't work from it unless I say so.

## The goal

Turn this from a repo-only project into a **deployed, clickable demo with a live URL.** I currently have zero live URLs across my entire portfolio, and that is the single biggest gap in my CV — recruiters won't read code, but they will click a link.

## The critical constraint — read this before proposing anything

I originally wanted a ChatGPT-style chatbot. **That is a trap, and I've accepted why.** GPT-2 124M is a *base* model, not instruction-tuned. It continues text rather than answering questions. A chat UI backed by GPT-2 produces rambling, repetitive output, so any recruiter who clicks it concludes the project is broken — strictly worse than the current README-only repo.

**The agreed reframe: build an inference playground, not a chatbot.**

- **Model switcher** across: GPT-2 (served by *my own* KV-cache engine — this is the part that demonstrates engineering), plus `Qwen2.5-0.5B-Instruct` and `SmolLM2-360M-Instruct` served via `transformers` (these are instruction-tuned, so they actually respond coherently and give the demo a working chat).
- **Live metrics panel** — tokens/sec, time-to-first-token, peak memory, and a **KV-cache ON/OFF toggle** so the latency difference is visible in real time.
- **The comparison is the product.** Weak GPT-2 output becomes a *demonstration* of what instruction tuning buys you, and the cache toggle demonstrates what my engine buys you. Both are features, not bugs.

This mirrors my SilverTouch internship work, where I benchmarked vLLM vs SGLang vs llama.cpp as serving backends — consistent story across CV and portfolio.

## Deployment target

**Hugging Face Spaces, free CPU tier** — 2 vCPU, 16GB RAM, unmetered, free indefinitely. Models run locally inside the Space, so there are no API costs. Constraints to design around and document in the README:
- Sleeps after 48h idle; 30–90s cold start on wake
- CPU only — every model must be CPU-viable (all three chosen models are)
- 50GB non-persistent disk

## Constraints and preferences

- **Budget is ₹0.** No paid GPU, no paid API tiers.
- **The frontend can be vibe-coded** — I'm not applying for frontend roles and I've accepted that tradeoff. But the **serving layer, streaming, cache logic, and metrics must be genuinely mine**, because that's what gets asked about.
- **I learn by building and hitting walls.** Don't send me to courses or docs to read first. Get me building, then explain the specific concept when I'm blocked.
- **Be direct.** No praise, no encouragement filler — go straight to the diagnosis.
- Don't recommend JAX for new work here; this is PyTorch.

## Where to start

1. Audit what's actually in `backend/app/app.py` and `frontend/src/` — I'm not certain how complete either is, so establish the real starting point before writing code.
2. Then design the model-agnostic serving interface so `model_kv.GPT` and HuggingFace `transformers` models sit behind one API with token streaming.
3. Metrics instrumentation and the cache toggle come next, then the UI, then the Space deploy.

Decide whether `~/dev/inference_benchmark` should be folded in as the benchmark harness before building, since that affects the repo layout.
