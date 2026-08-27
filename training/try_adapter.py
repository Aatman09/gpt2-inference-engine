"""Compare base GPT-2 against the LoRA adapter, same prompt, same seed.

The thing to look for is not fluency -- 124M is 124M -- but whether the
adapter ANSWERS and then STOPS. Base GPT-2 has no notion of a reply ending, so
it runs to the token limit every time; emitting <|endoftext|> is the clearest
evidence instruction tuning took.

    python training/try_adapter.py [gpt2|gpt2-medium|gpt2-large]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch
import torch.nn.functional as F
import tiktoken
from peft import LoraConfig, inject_adapter_in_model, set_peft_model_state_dict
from safetensors.torch import load_file

from model_kv import GPT

MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt2"
# the first run wrote adapters/instruct; later ones are named per base model
_candidates = [Path(f"adapters/{MODEL}-instruct"), Path("adapters/instruct")]
ADAPTER = next(
    (p / "adapter_model.safetensors" for p in _candidates if (p / "adapter_model.safetensors").exists()),
    _candidates[0] / "adapter_model.safetensors",
)
REAL_VOCAB, EOT = 50257, 50256
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# generous, so "ran to the limit" means the model genuinely would not stop
# rather than that the answer was cut off mid-sentence
MAX_NEW = 150

PROMPTS = [
    "What is the capital of France?",
    "List three primary colours.",
    "Why is the sky blue?",
    "Write a one-sentence summary of what a database index does.",
]

enc = tiktoken.get_encoding("gpt2")


@torch.no_grad()
def generate(model, instruction, temperature=0.7, top_k=40, seed=0):
    """Sample until <|endoftext|> or MAX_NEW. Returns (text, stopped_early)."""
    torch.manual_seed(seed)
    ids = enc.encode(f"User: {instruction}\nAssistant:")
    idx = torch.tensor([ids], device=DEVICE)
    logits, cache, _ = model(idx)
    out = []
    for _ in range(MAX_NEW):
        step = logits[:, -1, :].clone() / temperature
        # the padded vocab rows are untrained noise -- mask them before top_k
        # so all k slots go to real candidates
        step[:, REAL_VOCAB:] = -float("inf")
        v, _ = torch.topk(step, top_k)
        step[step < v[:, [-1]]] = -float("inf")
        nxt = torch.multinomial(F.softmax(step, dim=-1), 1)
        if nxt.item() == EOT:
            return enc.decode(out), True
        out.append(nxt.item())
        logits, cache, _ = model(nxt, cache)
    return enc.decode(out), False


def main() -> int:
    if not ADAPTER.exists():
        print(f"no adapter at {ADAPTER} -- run training/finetune_lora.py first")
        return 1

    print(f"base {MODEL} | adapter {ADAPTER}")
    model = GPT.from_pretrained(MODEL).to(DEVICE)
    inject_adapter_in_model(
        LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05,
                   target_modules=["attn.c_attn", "attn.c_proj"]),
        model,
    )
    result = set_peft_model_state_dict(model, load_file(str(ADAPTER), device=DEVICE))
    if result.unexpected_keys:
        print(f"WARNING unexpected keys: {result.unexpected_keys[:3]}")
    # AFTER injecting: peft leaves its wrappers in train mode, which would
    # leave lora_dropout live during generation
    model.eval()

    def with_adapter(on):
        for m in model.modules():
            if hasattr(m, "enable_adapters"):
                m.enable_adapters(on)

    stops = {"base": 0, "adapter": 0}
    for instruction in PROMPTS:
        print(f"\n{'=' * 70}\nUser: {instruction}")
        for label, on in (("base", False), ("adapter", True)):
            with_adapter(on)
            text, stopped = generate(model, instruction)
            stops[label] += stopped
            mark = "STOPPED" if stopped else f"ran to {MAX_NEW} tokens"
            print(f"\n-- {label} [{mark}]\n{text.strip()}")

    print(f"\n{'=' * 70}")
    print(f"emitted <|endoftext|>:  base {stops['base']}/{len(PROMPTS)}  "
          f"adapter {stops['adapter']}/{len(PROMPTS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
