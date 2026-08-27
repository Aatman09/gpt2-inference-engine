# GPT-2 LoRA finetune with swappable adapters

Instruction-tuning the base GPT-2 124M served by `model_kv.GPT` using **LoRA**, with
adapters that can be **swapped at runtime** against a single set of frozen base
weights.

This is the fast-follow that `docs/ROADMAP.md` deferred so the live URL wouldn't be
blocked. It is a training-side detour from the engine work (speculative decoding),
so decide which of the two ships first.

## Why LoRA here

Full finetuning would also fit in 6GB, so this is not a memory workaround. LoRA is
the right call because of what it does for the *product*:

- **One base model in memory, many behaviours.** Each adapter is ~1–5MB against a
  ~500MB base. On the free Spaces tier (2 vCPU / 16GB, non-persistent disk) you can
  hold several adapters resident and switch between them for free — impossible if
  each variant is a separate 500MB checkpoint.
- **Swapping is a live, visible demo.** Same weights, same KV-cache engine, same
  prompt — flip the adapter and the behaviour changes. That is a stronger exhibit
  than a static second model in the picker, and it pairs naturally with the existing
  cache ON/OFF toggle: two toggles, both showing something you built.
- **Cheap iteration.** A bad run costs a 3MB file, not a 500MB one. You can train
  several adapters (instruct, terse, a persona) and keep them all.

The trade-off to state plainly: LoRA at reasonable rank recovers most but not all of
full-finetune quality. At 124M on 15k examples, that difference is well below the
noise floor of how bad a 124M model is anyway.

## What this will and won't produce

Expect: short answers, format compliance, and **reliable stopping**. Do not expect
factual reliability or reasoning.

That is the point, not a shortfall. Against `Qwen2.5-0.5B-Instruct` in the same UI,
the *gap* is the exhibit. Frame it as a comparison arm, never as "the chatbot got
better", or it reads as broken.

---

## Stack — what we're using

### Already installed

| Thing | Version | Why |
|---|---|---|
| `tiktoken` | in `backend/pyproject.toml` | **Must** be the same `gpt2` encoding the engine uses (`gpt_kv.py:36`). Do not switch to the HF tokenizer. |
| `transformers` | 5.15.1 | Only pulls base GPT-2 weights once (`model_kv.py:151`). Not used for training. |
| `safetensors` | installed | **Adapter serialization format.** Use it over `torch.save` — adapters get loaded at request time from files that may be fetched remotely, and `.pth` is a pickle (arbitrary code execution on load). `safetensors` is a dumb tensor container and can't execute. |
| `numpy` | — | `.npy` shard convention from `training/prepare.py`. |
| `torch` | 2.13.0 | **See the CPU/GPU problem below.** |

### To install

| Thing | Why |
|---|---|
| `datasets` | Not installed in the active venv. Needed to pull Dolly. |
| `tqdm` | Same — imported by `prepare.py`, absent from `backend/.venv`. |

### LoRA implementation — hand-rolled, not `peft`

`peft` is **not installed, and we are not adding it.**

LoRA is a small amount of code: for a frozen `nn.Linear` of shape `(out, in)`, learn
`A: (r, in)` and `B: (out, r)`, and compute `y = W x + (alpha/r) · B(A x)`. Two
matmuls and a scale. Writing it yourself is maybe 40 lines.

Reasons to hand-roll here:

- **`peft` targets HF module conventions**, and `model_kv.GPT` is your own module
  tree (`transformer.h[i].attn.c_attn`, etc.). Bending `peft` around it is more work
  than writing the layer.
- **The interview claim.** The serving layer, cache logic, and now the adapter
  mechanism are the parts that get questions. `get_peft_model(...)` answers none of
  them; a `LoRALinear` you wrote and a swap path you designed answer all of them.
- **Runtime swapping is the actual feature**, and it's the part `peft`'s API makes
  *less* transparent, not more.

### Dataset

**`databricks/databricks-dolly-15k`** — 15k human-written examples, CC-BY-SA, with
an optional `context` field. Human-written beats `tatsu-lab/alpaca`'s GPT-3-generated
noise, and it's small enough to iterate on.

Later volume options: `HuggingFaceH4/no_robots` (10k, chat-shaped),
`OpenAssistant/oasst1` (trees, needs flattening).

For a *second* adapter to demo swapping, don't hunt for another dataset — derive one
from Dolly (filter to short responses for a "terse" adapter, or prepend a persona).
Same pipeline, near-zero extra work, and the contrast is clearer than two similar
instruct adapters.

### Not using — and why

- **`peft` / any LoRA library.** See above.
- **TRL `SFTTrainer` / HF `Trainer`.** The training loop is the defensible part.
  `train.py` already exists; fork it.
- **Quantization (QLoRA / bitsandbytes).** 124M in bf16 is ~250MB. Nothing to solve.
- **New special tokens.** Reuse `<|endoftext|>` (50256) — free, and `gpt_kv.py:98`
  already breaks on it.

### The environment problem — resolve this first

1. **The active venv (`backend/.venv`) is CPU-only torch** — `2.13.0+cpu`,
   `torch.version.cuda is None`. Deliberate: `backend/pyproject.toml` documents that
   the CUDA wheel is most of why the Docker image hit 15.8GB on Spaces' CPU tier.
   Training there runs on CPU and takes days.
2. **The GPU is an RTX 4050 Laptop — 6GB VRAM.**

So **do not train in `backend/.venv`.** Make a separate training venv with the CUDA
wheel (`uv sync --extra gpu`, or a standalone root `.venv`) and leave the backend's
CPU-only install alone. Mixing them re-inflates the deploy image.

**6GB with LoRA is comfortable** — this is where LoRA does help. Frozen base needs
weights only (~0.5GB fp32, no grads, no optimizer state); AdamW moments exist only
for the adapter (a few MB). Versus ~2GB for full finetuning. So:

- Start `B=8, T=512` (LoRA affords the batch full finetuning couldn't) with grad
  accumulation as `train.py:23` already does.
- Keep `torch.autocast(bfloat16)` (`train.py:44`) — Ada has native bf16.
- If OOM: halve `B` before anything else.
- `torch.compile` (`train.py:19`): **skip it initially.** It interacts badly with
  swapping modules in and out, and saves little on short runs.

**Fallback:** Colab/Kaggle free T4 (16GB), ₹0, preserving the zero-budget constraint.
Only training leaves the laptop; the artifact is a few-MB adapter file.

---

## Phase 0 — Lock the prompt format

Everything downstream depends on this. Settle it before writing code.

`gpt_kv.py:46-51` already renders:

```
User: {content}\nAssistant:
```

**Train on exactly that string.** A training/serving format mismatch silently
destroys quality and is the most common way this project fails.

Decide and write down:

- Turn separator, and **whether a space follows `Assistant:`** — `" Hello"` and
  `"Hello"` are different BPE tokens.
- How Dolly's `context` field renders (or whether those examples are dropped).
- Terminator: `<|endoftext|>` after every response.
- Whether a system preamble exists. **Recommend no** — the 1024-token budget is
  already tight (`gpt_kv.py:77` reserves room for generation).

**Write the renderer once**, imported by both data prep and `GPTKVEngine`. Never two
copies — that's how the formats drift apart three weeks later.

**Extra rule for multi-adapter:** every adapter trains on the *same* format. The
adapter changes behaviour; the scaffold stays fixed. Otherwise swapping requires
swapping the renderer too, and the serving path gets ugly.

## Phase 1 — The LoRA layer

New `training/lora.py`. This is the core of the project — get it right first.

**`LoRALinear`** wrapping a frozen `nn.Linear`:

- Hold a reference to the base layer; `requires_grad_(False)` on its params.
- `A: (r, in_features)`, `B: (out_features, r)`.
- **Init `A` random (small, e.g. Kaiming) and `B` to zeros.** So `BA = 0` at step 0
  and the adapted model starts *exactly* equal to base. Non-zero init means step 0
  output is random noise. This one line is the difference between converging and not.
- Forward: `base(x) + scaling * B(A(x))`, `scaling = alpha / r`.
- Optional dropout on the `A` branch.

**Which modules to target.** In `model_kv.py`, each block has `attn.c_attn`
(`n_embd → 3*n_embd`), `attn.c_proj`, `mlp.c_fc`, `mlp.c_proj`.

Start with **`c_attn` and `attn.c_proj` on all 12 blocks.** Attention projections
are the standard, best-understood target. Add MLP later only if quality demands it.
Note `c_attn` is the fused QKV projection — one LoRA across all three is normal and
fine.

**Hyperparameters to start:** `r=8`, `alpha=16` (so `scaling=2.0`), `dropout=0.05`.
`r=8` on attention projections of a 124M model is ~0.6M trainable params, ~0.5% of
the model.

**Injection.** Write a function walking the module tree, replacing target
`nn.Linear`s with `LoRALinear` wrappers in place. Keep it *by name pattern* so it's
inspectable and the same helper works at serving time.

**Verify before training anything:** after injection, assert only LoRA params have
`requires_grad=True`, print the trainable count, and confirm a forward pass gives
**bit-identical** output to the un-injected model (`B=0`). If those three don't hold,
nothing downstream will work.

## Phase 2 — Data prep

New `training/prepare_sft.py`, alongside `prepare.py`:

1. `load_dataset("databricks/databricks-dolly-15k")`.
2. Render via the Phase 0 function.
3. Tokenize with `tiktoken.get_encoding("gpt2")`.
4. Append EOT to every response.
5. Drop examples exceeding `T` (decide truncate-vs-drop, be consistent).
6. **Emit a loss mask:** `0` over prompt positions, `1` over response + EOT.
7. Hold out ~500 examples as validation **before** shuffling.

Pad to fixed `T` and store rectangular `.npy` arrays — simpler than variable-length
plus offsets, and it matches how the dataloader consumes it.

Parameterize the output dir so each adapter's dataset is a separate directory. Add
the SFT output dir to `.gitignore` (`fineweb_shards` is already there).

## Phase 3 — Loss masking

`model_kv.py:142-144` computes flat cross-entropy over every position. For SFT you
train only on response tokens — otherwise you teach the model to generate the user's
questions.

**Use ignore-index:** set masked target positions to `-100` in the dataloader.
`F.cross_entropy` ignores them by default. **Zero model changes** — which matters
more than usual here, since `model_kv.py` is also the serving path.

Two traps:

- **The off-by-one.** Targets are inputs shifted by one; mask position `i` in `y`
  by whether *that* token is a response token. Verify by decoding one batch and
  printing exactly which tokens carry loss — **before any training run.**
- **Padding must also be `-100`**, or you train the model to emit pad tokens.

## Phase 4 — Dataloader

`dataloader2.py:31-48` walks a contiguous stream with a sliding window — wrong shape
for SFT, where examples are discrete and must not bleed across boundaries.

New `SFTDataset`:

- Returns `(x, y, mask)` per example.
- Fixed `T`, padded.
- **Shuffles.** The current loader never does — irrelevant streaming 200M tokens,
  very relevant across 15k examples for 3 epochs.
- Real epoch boundaries for per-epoch validation.

**Known simplification to record, not fix:** pad tokens aren't attention-masked.
`is_causal=True` (`model_kv.py:60`) blocks attention to future positions anyway, so
with right-padding this is largely harmless.

## Phase 5 — Training loop

Fork `train.py` into `training/train_lora.py`.

| | Pretrain (current) | LoRA SFT |
|---|---|---|
| LR | `3e-4` flat (`train.py:29`) | **`1e-4` – `3e-4`**, cosine + warmup |
| Params | all | **LoRA only** |
| Steps | 500 (`train.py:26`) | 2–3 epochs |
| Loss | all tokens | response only |
| Batch | `B=8, T=512` | `B=8, T=512` |
| Eval | none | val loss per epoch |

**Note the LR does *not* drop the way full finetuning would.** Full SFT needs
`1e-5`–`3e-5` to avoid wrecking pretrained weights; LoRA's base is frozen and `B`
starts at zero, so it wants a *higher* LR — roughly full-finetune LR ×10. Starting at
`2e-5` is the standard way to get an adapter that appears to do nothing.

**Pass only LoRA params to the optimizer** — `filter(lambda p: p.requires_grad, ...)`.
Passing everything wastes optimizer state on frozen tensors and hides bugs.

Fix these while forking:

- `train.py:31-32` fetches a batch discarded and overwritten at line 40. Dead code.
- `train.py:46` appends per-*microbatch* loss; you want accumulated per-step.
- `train.py:68` hardcodes `shakespeare_gpt.pth`.
- Checkpoint **every epoch**, not just at the end.

**Saving — the key difference from full finetuning.** Save *only* LoRA params, as
`safetensors`, plus a small JSON sidecar recording `r`, `alpha`, dropout, target
module patterns, base model identity, and the prompt-format version from Phase 0.
Without that metadata an adapter file is unloadable six weeks later. Never save the
base weights — that's the entire point.

## Phase 6 — Evaluation

**Automatic:** validation loss on the held-out split; plot train vs. val and pick the
checkpoint at divergence.

**Manual, and this decides whether it ships:** ~20 fixed prompts, run against base
GPT-2 and each adapter, outputs saved per checkpoint so they diff. Look for:

- Does it **stop**? (EOT emitted — the clearest signal SFT worked.)
- Does it answer the question asked?
- Is it on-format?

Watch for the classic failure: loss curve looks great, generations are garbage.
Always eyeball samples.

**LoRA-specific check:** confirm that unloading the adapter restores base behaviour
*exactly*. If base-after-unload differs from base-before-load, the swap mutates state
it shouldn't — a bug that will surface as one user's request poisoning the next.

## Phase 7 — Serving with runtime swapping

The interface anticipated a tuned checkpoint (`gpt_kv.py:5`), but **not** adapters.
This phase is real design work, not a config change.

**Swap mechanism — pick one:**

- **Swap the LoRA tensors, keep the wrappers** (recommended). Inject `LoRALinear`
  once at load; swapping copies new `A`/`B` weights into existing modules, or sets
  them to a no-op for "base". Cheap, allocation-free, no tree surgery per request.
- **Merge and unmerge** (`W += scaling·BA`). Fastest inference — zero adapter
  overhead — but repeated merge/unmerge accumulates float error, and a merged base is
  no longer pristine. Fine if you only ever merge one adapter at startup; bad for
  live switching.
- Rebuild the module tree per swap. Simple, too slow to do per request.

**Concurrency — the thing that will actually bite.** `EngineRegistry` caches **one
engine instance per model** (`registry.py:41`), shared across all users. Adapter
state is per-request but the model is global, so two users on different adapters will
corrupt each other's generation.

Options, in order of preference for this project:

1. **A lock around adapter-swap + generation.** Correct, trivial, and on a 2-vCPU
   free tier where generation is already serialized by the GIL, it costs nearly
   nothing. Start here.
2. One engine instance per adapter. Simple, but duplicates the base model in
   memory — defeating the main reason to use LoRA.
3. Batch by adapter. Correct and fast; far beyond what this tier needs.

Do not skip this. A demo that breaks when two people open it is worse than no demo.

**API surface.** Adapter selection is *not* a model — don't add adapters to
`ModelName` (`schemas.py:16`), or `gpt2 × N adapters` combinatorially pollutes an
enum documented as mirroring `_ENGINE_SPECS` keys. Instead:

- Add an optional `adapter: str | None` to `PredictRequests` (`schemas.py:21`),
  alongside `use_cache` — same shape of concern: a knob only some engines honour.
- Add `supports_adapters` to the `Engine` ABC (`base.py:59`), mirroring
  `supports_cache_toggle`, plus a way to list available adapters.
- Surface the list via `/health`, which already reports `loaded_models`
  (`app.py:105`) and does exactly this for `google_enabled` — the frontend hides
  controls the server can't back.

**Frontend.** An adapter dropdown next to the cache toggle, shown only when the
selected engine reports `supports_adapters`. `ModelPicker.jsx` is the reference for
the pattern.

**Distribution.** Adapters are a few MB — small enough to commit, unlike a 500MB
checkpoint. Still cleaner on the HF Hub next to the base model; the free tier's disk
is non-persistent, so anything not in the image is re-fetched on cold start. A few MB
is a fine cold-start cost.

---

## Order of work

**Phase 1 first, and verify it in isolation** — LoRA layer + injection + the
three assertions (only adapter params trainable, correct trainable count,
bit-identical forward at init). Everything else is worthless if this is subtly wrong,
and it's the cheapest thing to test.

Then Phases 0, 2, 3 together: format and masking are the hard-to-debug parts and are
cheap to verify up front.

Then, before any real run: **overfit 100 examples deliberately.** Train until the
adapter reproduces those responses verbatim. If it can't, the mask, the format, or
the LoRA wiring is wrong — and you learn that in two minutes instead of after a full
run. This catches zero-init and LR mistakes immediately.

Then Phase 5 for real, Phase 6, then **train a second adapter before building Phase
7** — the swap path is much easier to design correctly with two real adapters in hand
than with one and an imagined second.
