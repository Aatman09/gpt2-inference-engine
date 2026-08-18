# achat differentiators — speculative decoding + INT8 quantization

Design doc for the two features that make this project more than a chat-UI wrapper around
GPT-2. See `docs/ROADMAP.md` for the phased build (auth, persistence, frontend); this is
the engine-layer work that sits on top of it.

## Why these two

The finetune (hand-rolled SFT — not Unsloth; Unsloth needs CUDA kernels and targets
Llama/Mistral-family architectures, not GPT-2) is a checkbox, not the centerpiece. The
centerpiece has to:

- sit in the backend serving layer — the part that gets interview questions, not the
  frontend, which is scaffolding
- run on the HF Spaces free CPU tier (2 vCPU, ₹0 budget, no GPU in prod)
- be a concrete, checkable claim ("I implemented speculative decoding") rather than vague
  optimization language

Speculative decoding and INT8 quantization attack different bottlenecks — algorithmic vs.
numerical — and stack with the KV-cache work already done. That gives three independent,
explainable levers on the same metrics panel: cache toggle (memory-access win),
quantization (numerics win), speculative decoding (algorithmic win).

**Rejected: side-by-side model race.** Measured two concurrent generations at ~40ms/token
each vs. ~21ms solo — torch's intra-op thread pool is already saturated by one stream on 2
vCPU, so concurrent wall time ≈ sequential. A race would ship a headline benchmark that
measures its own scheduler contention.

### Verified on this machine (2 threads, simulating the Spaces tier)

| Measurement | Result |
|---|---|
| Cached decode (fp32 baseline) | **16.8 ms/token** |
| Naive full-sequence decode at T=84 | **171.6 ms/token — 10.2× slower** (existing cache toggle) |
| **INT8 dynamic-quantized cached decode** | **10.5 ms/token — 1.6× over fp32** |
| KV-cache byte formula vs. measured tensor bytes | exact match |
| `distilgpt2` vs. `gpt2` tokenizer/vocab | **identical** (50257, `get_vocab()` equal) — viable draft/target pair |
| `distilgpt2` via `model_kv.GPT.from_pretrained` | **fails** — that loader hardcodes the 4 canonical GPT-2 configs (`model_kv.py:146-151`); distilgpt2 is 6-layer and doesn't match any of them |

---

## Feature 1 — Speculative decoding

A small **draft model** proposes several tokens autoregressively; the **target model**
(the 124M GPT-2) verifies all of them in a single forward pass, accepting each with
probability `min(1, p_target/p_draft)` and resampling on rejection (standard
Leviathan/Chen algorithm — exact target distribution, not an approximation). When
acceptance is high, one target forward pass yields multiple output tokens instead of one,
cutting wall-clock latency without changing what gets generated.

**Draft/target pairing:** `distilgpt2` (82M, 6-layer) drafting for `gpt2` (124M, 12-layer)
target. Confirmed identical tokenizer/vocab — required, since acceptance sampling compares
token-aligned distributions. This is the one pairing in the current lineup that works:
Qwen and SmolLM2 use different tokenizers entirely, so nothing here can draft for them, and
GPT-2 is already the smallest served model, so it needs an even-smaller same-family
sibling rather than one of the existing three.

**Loader gap to close first:** `model_kv.GPT.from_pretrained` only accepts
`{gpt2, gpt2-medium, gpt2-large, gpt2-xl}` (`model_kv.py:143`, `config_args` dict at
146-151) — distilgpt2 asserts-fails there (different layer count). Two options, pick
one explicitly rather than discovering it mid-implementation:

- **(recommended)** Load the draft via plain `transformers.GPT2LMHeadModel` — it's small
  enough (82M) that it doesn't need the KV-cache engine to be fast; a naive forward per
  draft step is fine at this scale. Keeps `model_kv.py` untouched.
- Alternatively, extend `GPTConfig`/`config_args` to accept distilgpt2's shape
  (`n_layer=6, n_embd=768, n_head=12`) and run the draft through the custom engine too —
  more consistent, more code, marginal benefit since the draft's speed isn't the
  bottleneck.

### Where this lives

New `backend/app/engine/speculative.py`, implementing the `Engine` ABC directly (not a
subclass of `GPTKVEngine` — the generation loop is structurally different: draft-K,
verify-1, not decode-one-at-a-time).

```python
class SpeculativeEngine(Engine):
    supports_cache_toggle = True   # verification path can still use the target's KV cache
    supports_speculative_stats = True   # new flag, see below

    def __init__(self, target: GPT, draft: GPT2LMHeadModel, draft_tokens: int = 4, device="cpu"):
        ...

    def stream(self, params: GenerationParams) -> Iterator[TokenEvent]:
        # 1. draft model proposes `draft_tokens` tokens autoregressively (cheap, own small
        #    forward passes — no cache needed at this scale)
        # 2. target model verifies all proposed + 1 in ONE forward pass using its KV cache
        #    (this is the speedup: one target pass instead of `draft_tokens` of them)
        # 3. accept/reject per standard algorithm; on rejection, resample from the
        #    corrected distribution (target_probs - draft_probs, clipped, renormalised)
        #    and discard the rest of that draft batch
        # 4. yield accepted tokens as TokenEvents; advance the target's kv_caches
        #    correctly for however many were actually accepted
```

**Add to `base.py`:** a `TokenEvent` type (if not already present from other work) plus a
per-step stat: `accepted_count: int` and `proposed_count: int` on whichever telemetry
object carries generation stats. Emit an aggregate `acceptance_rate` on the `done` SSE
frame — this is the number that makes the technique legible and is the thing worth
plotting.

**Registry wiring:** add `"gpt2-speculative": (SpeculativeEngine, "gpt2")` to
`_ENGINE_SPECS` in `registry.py` as a fourth model-picker entry, alongside plain `gpt2` —
so a visitor can A/B the same prompt against the same target model with and without
speculation and watch the tok/s number move. `registry.get()`'s existing
`engine_cls is GPTKVEngine` branch (line 40) needs a sibling branch for constructing
`SpeculativeEngine` with both the target and draft loaded.

**Risk — acceptance rate on a base model.** Distribution alignment between draft and
target drives acceptance rate; below ~50% the overhead of running the draft model plus
verification can net-lose against plain cached decoding. `distilgpt2` is literally
distilled from `gpt2`, so alignment should be good, but this must be **measured, not
assumed** — log acceptance rate from the first real runs and report the actual number
rather than citing a textbook figure. If acceptance is poor, say so and explain why
(distillation temperature, base-model high-entropy rambling hurting alignment) — that's
still a good interview answer, just a different one.

**Risk — CPU parallel verification.** The core win (verifying K tokens in one forward pass
instead of K sequential passes) still holds on CPU — it's a batched-sequence matmul either
way — but the "free" parallelism GPUs get from wide verification batches doesn't apply.
Benchmark the actual wall-clock gain on the 2-vCPU profile rather than assuming
GPU-literature speedups transfer.

---

## Feature 2 — INT8 dynamic quantization

`torch.quantization.quantize_dynamic(model, {nn.Linear}, dtype=torch.qint8)` applied to
the loaded GPT-2 target. Verified: **16.8ms → 10.5ms/token, 1.6× on CPU**, no GPU involved
— this is specifically a CPU-inference technique (dynamic quantization uses
`fbgemm`/`qnnpack` CPU kernels), a better fit for the actual Spaces deployment target than
the training-side (CUDA) work already covered by the finetune.

### Where this lives

A distinct `"gpt2-int8"` registry entry, matching the pattern used for the speculative
variant — keeps every variant independently selectable in the model picker and
independently benchmarkable, which is the whole point of the comparison framing.
Quantization is applied once at load time, after `GPT.from_pretrained` and before
`.eval()`/`.to(device)`.

**Interface impact: none.** `quantize_dynamic` returns a model with the same `forward`
signature — `GPTKVEngine`'s existing `stream()` logic (both cached and naive branches)
runs unmodified against the quantized model. This is the cheapest of the two features by a
wide margin: no new Engine subclass, no ABC change, just a registry entry and a few lines
in the constructor.

**Metrics to expose:** parameter memory footprint before/after (dynamic quantization
roughly quarters `Linear` weight memory: fp32→int8 on the weight tensors, activations stay
fp32) alongside the measured tok/s delta. `parameter_count()` already exists on `Engine`
but is currently unused — this is its first real consumer. Pair it with a byte-size
computation for a genuine memory-vs-speed tradeoff chart.

**Risk:** accuracy/quality degradation from quantization is usually small for INT8 but
should be spot-checked qualitatively (generate the same prompt fp32 vs. int8, confirm
outputs are reasonable) rather than assumed lossless — state whatever's observed rather
than asserting "zero quality loss."

---

## Sequencing

1. Benchmark `distilgpt2` draft-only forward latency standalone, to confirm the draft step
   doesn't eat the verification step's gain.
2. **Quantization first** — smaller, lower-risk, validates the registry/model-picker
   pattern before the more complex speculative engine uses the same pattern.
3. `base.py` — extend `TokenEvent`/telemetry shape with `accepted_count`/`proposed_count`
   if not already present.
4. `speculative.py` — implement `SpeculativeEngine`, using plain
   `transformers.GPT2LMHeadModel` for the draft (per the loader-gap decision above).
5. `registry.py` — add `gpt2-int8` and `gpt2-speculative` entries; extend the
   `engine_cls is X` construction branch for the new types.
6. `schemas.py` — extend `ModelName` enum with the two new values (the comment at
   `schemas.py:11-12` already flags this enum as the only validation before the registry
   dict lookup — keep it in sync).
7. Verify by curl/direct script: acceptance rate is real and logged, int8 output is
   qualitatively sane, and both new model-picker entries produce valid SSE streams.
8. Frontend: add the two entries to the existing `MODEL_OPTIONS` list (duplicated in
   `TopBar.jsx` and `SettingsPage.jsx` — update both), surface `acceptance_rate` in the
   metrics footer next to the existing tok/s figure.

### Critical files

- `backend/app/engine/base.py` — Engine ABC, GenerationParams, TokenEvent/telemetry shape
- `backend/app/engine/gpt_kv.py` — quantization hook point, existing `_sample`/`stream` reused as-is
- `backend/app/engine/speculative.py` — new file, the draft/verify/accept-reject loop
- `backend/app/engine/registry.py` — `_ENGINE_SPECS`, `EAGER_LOAD`, the `engine_cls is X` construction branch
- `backend/app/schemas.py` — `ModelName` enum
- `model_kv.py` — read-only reference for the target's `forward`/KV-cache shape; not modified unless the draft is routed through it (rejected option above)
- `frontend/src/components/TopBar.jsx`, `frontend/src/pages/SettingsPage.jsx` — `MODEL_OPTIONS` (duplicated, both need the new entries)

## Verification

- Time `distilgpt2` draft forward passes standalone; confirm draft cost stays well under
  the ~16.8ms/token cached-decode baseline it's trying to beat, per drafted token.
- Log real acceptance rate over several generations; report the actual number, not a
  literature figure.
- `curl -N` the new `gpt2-speculative` and `gpt2-int8` model picker entries; confirm valid
  SSE frames end-to-end same as the existing `gpt2` entry.
- Compare fp32 vs. int8 output qualitatively on a fixed prompt set.
- Confirm `gpt2-speculative`'s output text, run with a fixed seed, matches plain `gpt2`
  greedy/sampled output under equivalent settings where feasible — speculative decoding
  should be exactness-preserving; a mismatch signals a bug in the accept/reject math, not a
  feature.
