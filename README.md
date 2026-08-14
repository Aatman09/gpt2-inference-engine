# achat — GPT-2 from scratch, with KV-cache inference

A from-scratch PyTorch implementation of GPT-2, trained on FineWeb + Shakespeare,
extended with a **custom KV-cache inference engine** and benchmarked against the
no-cache baseline.

## What's in here

| File              | What it does                                                    |
|-------------------|-----------------------------------------------------------------|
| `train.py`        | Pretraining on FineWeb shards (bf16 autocast, grad-accum, clip) |
| `dataloader2.py`  | Sharded FineWeb dataloader                                      |
| `inference.py`    | Naive generation (recomputes K/V every step)                    |
| `model_kv.py`     | GPT-2 with KV cache plumbed through attention + Block + GPT     |
| `inference_kv.py` | Cached generation for the fine-tuned shakespeare model          |
| `backend/`        | FastAPI serving layer, wraps `model_kv.py` for a `/predict` endpoint |
| `frontend/`       | React chat UI                                                   |

## The KV cache, in one paragraph

Naive generation re-runs the full sequence through every transformer block on
every new token: at step `t`, you recompute K and V for all `t` past tokens,
even though they haven't changed. KV caching saves K and V per layer once they're
computed, so each decode step does just one new token's worth of attention work.
Quadratic per-step cost becomes linear.

In `model_kv.py`, the cache is a list of `(k, v)` tensors, one per block:
- On the first call (`kv_caches=None`), the prefill runs as normal and the
  returned `new_kv_caches` are the K/V for every block.
- On each decode call, you pass a single new token plus the cache; each block
  concatenates the new K/V onto the past and returns the updated cache.
- `is_causal=True` only when `q.shape[2] == k.shape[2]` (prefill); during
  decode, the lone query attends to all past keys, no mask needed.
- Position IDs are continued from `past_length` so `wpe` doesn't reset to 0.

## Reproducing

```bash
pip install torch transformers tiktoken numpy matplotlib
python inference_kv.py   # requires shakespeare_gpt.pth from training
```
