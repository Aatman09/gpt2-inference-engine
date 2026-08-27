"""Phase 1 verification -- run this before writing any training code.

Everything downstream is worthless if the LoRA wiring is subtly wrong, and a
broken adapter fails silently: loss drops, checkpoints save, generations are
unchanged. These checks are seconds long and catch every failure mode that
would otherwise cost a full training run to discover.

Using peft does not make them unnecessary. peft gets the algorithm right; what
these assert is that it is wired to THIS model correctly -- that the target
patterns matched the layers we meant, that the freeze took, and that injection
did not leave dropout switched on at inference time (it does, by default; see
inject_lora).

Uses a randomly-initialised GPT rather than from_pretrained('gpt2') on purpose:
none of these properties depend on the weight values, so there is no reason to
download 500MB or require a network to run the test.

    python training/full/verify_lora.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import torch
import torch.nn as nn
from peft.tuners.lora import LoraLayer

from model_kv import GPT, GPTConfig
from lora import (
    AdapterMeta,
    adapter_names,
    build_lora_config,
    inject_lora,
    load_adapter,
    lora_layers,
    lora_parameters,
    save_adapter,
    set_active_adapter,
    set_lora_enabled,
    trainable_summary,
)

SEED = 1337


def build_model() -> GPT:
    torch.manual_seed(SEED)
    model = GPT(GPTConfig())
    # eval() so dropout is the identity -- otherwise "bit-identical" is not a
    # meaningful claim and every check below compares noise. Deliberately
    # BEFORE injection, which is the ordering that exposes the mode bug.
    model.eval()
    return model


def fixed_input() -> torch.Tensor:
    g = torch.Generator().manual_seed(SEED)
    return torch.randint(0, 50257, (2, 16), generator=g)


def logits_of(model: GPT, idx: torch.Tensor) -> torch.Tensor:
    with torch.no_grad():
        logits, _, _ = model(idx)
    return logits


def perturb(model: GPT, adapter: str, std: float) -> None:
    """Give an adapter a non-zero B, i.e. make it actually do something."""
    with torch.no_grad():
        for _, layer in lora_layers(model):
            layer.lora_B[adapter].weight.normal_(std=std)


def check(label: str, passed: bool, detail: str = "") -> bool:
    print(f"  [{'PASS' if passed else 'FAIL'}] {label}{f' -- {detail}' if detail else ''}")
    return passed


def main() -> int:
    idx = fixed_input()
    config = build_lora_config(r=8, alpha=16, dropout=0.05)

    base_logits = logits_of(build_model(), idx)

    model = build_model()
    wrapped = inject_lora(model, config, adapter_name="instruct")

    results = []
    print("\ninjection")
    # 12 blocks x {c_attn, attn.c_proj}. If this is 12, one of the two target
    # patterns matched nothing; if 48, "c_proj" leaked into the MLP.
    results.append(check("wrapped 24 layers", len(wrapped) == 24, f"got {len(wrapped)}"))
    results.append(check(
        "targeted only attention projections",
        all(n.endswith(("attn.c_attn", "attn.c_proj")) for n in wrapped),
    ))
    results.append(check(
        "injection preserved eval mode",
        not any(layer.training for _, layer in lora_layers(model)),
        "peft leaves wrappers in train mode; inject_lora restores it",
    ))

    print("\nfreezing")
    trainable_names = [n for n, p in model.named_parameters() if p.requires_grad]
    results.append(check(
        "only lora_A/lora_B are trainable",
        all(".lora_A." in n or ".lora_B." in n for n in trainable_names),
        f"{len(trainable_names)} trainable tensors",
    ))
    # r=8: c_attn is 8*768 + 2304*8 = 24576, attn.c_proj is 8*768 + 768*8 =
    # 12288, so 36864 per block across 12 blocks. If this number is huge the
    # freeze did not take and you are full-finetuning at LoRA's learning rate.
    trainable, total = trainable_summary(model)
    results.append(check(
        "trainable count is 442,368",
        trainable == 442_368,
        f"{trainable:,} of {total:,} ({100 * trainable / total:.2f}%)",
    ))

    print("\ninit is a no-op (B == 0)")
    results.append(check(
        "forward is bit-identical to un-injected base",
        torch.equal(base_logits, logits_of(model, idx)),
    ))

    print("\nthe branch is actually wired")
    # Necessary because the check above ALSO passes for a forward() that never
    # reaches the LoRA branch. An adapter that does nothing passes almost every
    # other test in this file.
    perturb(model, "instruct", std=0.02)
    instruct_logits = logits_of(model, idx)
    results.append(check(
        "non-zero B changes the output",
        not torch.equal(base_logits, instruct_logits),
        f"max abs diff {(base_logits - instruct_logits).abs().max():.3e}",
    ))

    print("\ndisable restores base exactly")
    # the swap path's "no adapter" option -- if this drifts, unloading an
    # adapter leaves residue and one request poisons the next
    set_lora_enabled(model, False)
    results.append(check(
        "disabled is bit-identical to base, even with non-zero B",
        torch.equal(base_logits, logits_of(model, idx)),
    ))
    set_lora_enabled(model, True)
    results.append(check("re-enabling restores the adapter", torch.equal(instruct_logits, logits_of(model, idx))))

    print("\ntwo adapters, one set of base weights")
    # the actual product feature: several behaviours resident against ~650MB of
    # base weights loaded once, switched without a reload
    inject_lora(model, build_lora_config(r=8, alpha=16, dropout=0.05), adapter_name="terse")
    results.append(check("both adapters resident", adapter_names(model) == ["instruct", "terse"],
                         str(adapter_names(model))))
    perturb(model, "terse", std=0.05)
    set_active_adapter(model, "terse")
    terse_logits = logits_of(model, idx)
    results.append(check("terse differs from instruct", not torch.equal(instruct_logits, terse_logits)))
    set_active_adapter(model, "instruct")
    results.append(check("swapping back is exact", torch.equal(instruct_logits, logits_of(model, idx))))

    print("\nsave / load round-trip")
    meta = AdapterMeta(base_model="gpt2", prompt_format="v0-test", dataset="none")
    with tempfile.TemporaryDirectory() as tmp:
        save_adapter(model, tmp, config, meta, adapter_name="instruct")
        saved = sorted(p.name for p in Path(tmp).iterdir())
        results.append(check("wrote weights + config + meta", len(saved) == 3, ", ".join(saved)))
        # a fresh model with no wrappers -- load_adapter must inject them from
        # the saved config, which is exactly the serving-time path
        reloaded = build_model()
        loaded_config, loaded_meta = load_adapter(reloaded, tmp, adapter_name="instruct")
        results.append(check("config round-trips", loaded_config.r == config.r))
        results.append(check("prompt format survives", loaded_meta.prompt_format == "v0-test"))
        results.append(check(
            "reloaded adapter reproduces the same logits",
            torch.equal(instruct_logits, logits_of(reloaded, idx)),
        ))
        # the whole reason to use LoRA: the artifact is megabytes, not the
        # ~650MB a full checkpoint of this model would be
        size_mb = (Path(tmp) / "adapter_model.safetensors").stat().st_size / 1e6
        results.append(check("adapter is a few MB", size_mb < 10, f"{size_mb:.2f} MB"))

    print("\ngradients")
    model.zero_grad(set_to_none=True)
    logits, _, _ = model(idx)
    logits.sum().backward()
    # only the ACTIVE adapter should receive gradients -- "terse" is resident
    # but inactive, and an optimizer step must not drift it
    active = [p for n, p in model.named_parameters() if ".instruct." in n and p.grad is not None]
    inactive = [p for n, p in model.named_parameters() if ".terse." in n and p.grad is not None]
    frozen = [n for n, p in model.named_parameters()
              if ".lora_" not in n and p.grad is not None]
    results.append(check("every active-adapter parameter got a gradient", len(active) == 48,
                         f"{len(active)} of 48"))
    results.append(check("the inactive adapter got none", not inactive, f"{len(inactive)} leaked"))
    results.append(check("no frozen parameter got a gradient", not frozen, f"{len(frozen)} leaked"))

    print("\nlayer shapes")
    sample = dict(lora_layers(model))["transformer.h.0.attn.c_attn"]
    results.append(check(
        "c_attn: A is (8, 768), B is (2304, 8)",
        tuple(sample.lora_A["instruct"].weight.shape) == (8, 768)
        and tuple(sample.lora_B["instruct"].weight.shape) == (2304, 8),
        f'A{tuple(sample.lora_A["instruct"].weight.shape)} '
        f'B{tuple(sample.lora_B["instruct"].weight.shape)}',
    ))
    results.append(check("scaling is alpha/r = 2.0", sample.scaling["instruct"] == 2.0))
    results.append(check("base layer is still an nn.Linear", isinstance(sample.base_layer, nn.Linear)))
    results.append(check("wrapper is a peft LoraLayer", isinstance(sample, LoraLayer)))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
