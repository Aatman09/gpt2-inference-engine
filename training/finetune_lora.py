"""Instruction-tune GPT-2 with a LoRA adapter, via peft.

    python training/finetune_lora.py [gpt2|gpt2-medium|gpt2-large] [batch]

All GPT-2 sizes share the same module names, so the LoRA targets and the rest
of the pipeline are unchanged across them -- only the base weights and the
batch size that fits in VRAM differ.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import torch
import tiktoken
from datasets import load_dataset
from peft import LoraConfig, get_peft_model_state_dict, inject_adapter_in_model
from safetensors.torch import save_file

from model_kv import GPT

MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt2"
T, EPOCHS, LR = 512, 3, 2e-4
BATCH = int(sys.argv[2]) if len(sys.argv) > 2 else 4
EOT, IGNORE = 50256, -100
OUT = Path(f"adapters/{MODEL}-instruct")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# bf16 on Ada is native and roughly halves both step time and activation
# memory, which is what makes the larger bases fit at all. CPU bf16 autocast
# falls back to kernels that barely thread, so it stays CUDA-only.
AUTOCAST = {"device_type": DEVICE, "dtype": torch.bfloat16, "enabled": DEVICE == "cuda"}

enc = tiktoken.get_encoding("gpt2")


def encode(instruction, response):
    """One example as (x, labels). labels is x shifted left, -100 on the prompt
    so loss lands only on the response -- train on everything and you teach the
    model to generate the user's questions too."""
    prompt = enc.encode(f"User: {instruction}\nAssistant:")
    reply = enc.encode(f" {response.strip()}<|endoftext|>", allowed_special={"<|endoftext|>"})
    full = prompt + reply
    if len(full) > T + 1:
        return None
    x, labels = np.full(T, EOT), np.full(T, IGNORE)
    x[: len(full) - 1] = full[:-1]
    labels[len(prompt) - 1 : len(full) - 1] = full[len(prompt) :]
    return x, labels


dolly = load_dataset("databricks/databricks-dolly-15k", split="train")
pairs = [e for e in (encode(r["instruction"], r["response"]) for r in dolly if not r["context"]) if e]
x = torch.tensor(np.stack([a for a, _ in pairs]))
y = torch.tensor(np.stack([b for _, b in pairs]))
print(f"{len(x)} examples | {MODEL} | batch {BATCH} | device {DEVICE}")

# base weights first, then inject -- wrapping moves each Linear to .base_layer
model = GPT.from_pretrained(MODEL).to(DEVICE)
lora_config = LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05,
                          target_modules=["attn.c_attn", "attn.c_proj"])
inject_adapter_in_model(lora_config, model)
params = [p for p in model.parameters() if p.requires_grad]
print(f"trainable {sum(p.numel() for p in params):,} of {sum(p.numel() for p in model.parameters()):,}")

opt = torch.optim.AdamW(params, lr=LR)
for epoch in range(EPOCHS):
    perm = torch.randperm(len(x))  # examples are discrete here, so shuffle every epoch
    for step, i in enumerate(range(0, len(x), BATCH)):
        batch = perm[i : i + BATCH]
        with torch.autocast(**AUTOCAST):
            _, _, loss = model(x[batch].to(DEVICE), targets=y[batch].to(DEVICE))
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        opt.zero_grad(set_to_none=True)
        if step % 100 == 0:
            print(f"epoch {epoch} | step {step}/{len(x) // BATCH} | loss {loss.item():.4f}")

OUT.mkdir(parents=True, exist_ok=True)
save_file(get_peft_model_state_dict(model), str(OUT / "adapter_model.safetensors"))
# without this the weights are unloadable: reconstructing the LoRA wrappers
# before loading tensors into them needs r/alpha/targets, and they were never
# written anywhere else
lora_config.save_pretrained(str(OUT))
print(f"adapter saved to {OUT}")
