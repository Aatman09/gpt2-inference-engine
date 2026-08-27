"""LoRA setup for model_kv.GPT, built on `peft`.

peft targets HuggingFace's module conventions, but model_kv.GPT is plain
nn.Linear all the way down, so `inject_adapter_in_model` matches its layers by
name with no adaptation needed. Injection is done IN PLACE rather than through
`get_peft_model`: that keeps `model` a real GPT, so the engine can keep calling
`model(next_token, kv_caches)` and getting its (logits, kv_caches, loss) tuple
back. A PeftModel wrapper would sit in the middle of that signature.

What this module adds on top of peft:

  * the eval-mode fix in inject_lora (see the comment there -- peft does not
    do this, and it silently breaks inference),
  * an AdapterMeta sidecar for the metadata peft's LoraConfig has nowhere to
    put, chiefly the prompt format the adapter was trained on,
  * one place where the target modules and defaults are decided.

IMPORTANT ordering constraint: injection replaces `...attn.c_attn` with a
peft `lora.Linear` holding the original at `.base_layer`, so state-dict keys
under a wrapped layer gain a `.base_layer` segment. Load base weights BEFORE
injecting, always.
"""
import json
from dataclasses import dataclass, asdict
from pathlib import Path

import torch
import torch.nn as nn
from peft import (
    LoraConfig,
    get_peft_model_state_dict,
    inject_adapter_in_model,
    set_peft_model_state_dict,
)
from peft.tuners.lora import LoraLayer
from safetensors.torch import load_file, save_file

# peft's own filenames, so an adapter directory is loadable by stock peft too
ADAPTER_WEIGHTS = "adapter_model.safetensors"
ADAPTER_CONFIG = "adapter_config.json"
ADAPTER_META = "adapter_meta.json"

# Attention projections on every block: the standard, best-understood target.
# "attn.c_proj" rather than bare "c_proj" -- peft matches on a trailing
# ".{target}", and MLP has a c_proj too (mlp.c_proj) that we are not adapting.
DEFAULT_TARGETS = ["attn.c_attn", "attn.c_proj"]

DEFAULT_ADAPTER = "default"


@dataclass
class AdapterMeta:
    """The metadata LoraConfig has no field for.

    Saved beside peft's adapter_config.json because six weeks later that file
    tells you r, alpha and the targets but not the one thing that silently
    destroys quality rather than erroring: what prompt format the adapter was
    trained against. A format mismatch between training and serving loads
    fine and generates garbage.
    """
    base_model: str = "gpt2"
    prompt_format: str = "unset"   # set from the Phase 0 renderer's version
    dataset: str = ""
    notes: str = ""


def build_lora_config(
    r: int = 8,
    alpha: int = 16,
    dropout: float = 0.05,
    targets: list[str] | None = None,
) -> LoraConfig:
    """r=8 on attention projections of a 124M model is ~442k trainable params.

    alpha/r is the adapter's scaling, so keeping alpha at 2*r means changing
    rank is a capacity knob and not a silent change to effective strength.
    """
    return LoraConfig(
        r=r,
        lora_alpha=alpha,
        lora_dropout=dropout,
        target_modules=list(targets or DEFAULT_TARGETS),
        bias="none",
        # peft inits lora_B to zeros, so B@A == 0 and the adapted model is
        # EXACTLY the base model at step 0 -- training walks away from
        # pretrained behaviour instead of climbing back to it. Left explicit
        # because it is the single assumption everything downstream rests on;
        # verify_lora.py asserts it rather than trusting it.
        init_lora_weights=True,
    )


def inject_lora(
    model: nn.Module,
    config: LoraConfig,
    adapter_name: str = DEFAULT_ADAPTER,
) -> list[str]:
    """Wrap the targeted nn.Linears in place and freeze everything else.

    Call more than once with different adapter_names to hold several adapters
    against one set of base weights -- that is the whole reason to use LoRA
    here, and switching between them is set_active_adapter().

    Returns the wrapped module paths so the caller can assert it got what it
    expected instead of trusting a silent walk.
    """
    was_training = model.training

    inject_adapter_in_model(config, model, adapter_name=adapter_name)

    # nn.Module.__init__ defaults training=True, and attaching a submodule to
    # an already-eval()'d parent does NOT inherit its mode -- so injecting into
    # a model in eval mode silently switches lora_dropout back on for the
    # adapter branch only. At serving time that is non-deterministic generation
    # from a model whose .training reports False. peft does not handle this;
    # restoring the mode we found is this module's job.
    model.train(was_training)

    wrapped = [name for name, _ in lora_layers(model)]
    if not wrapped:
        raise ValueError(
            f"no modules matched target_modules={config.target_modules} -- check them "
            f"against model.named_modules(). A typo here trains nothing and reports success."
        )
    return wrapped


def lora_layers(model: nn.Module):
    """Yield (path, layer) for every peft-wrapped layer."""
    for name, module in model.named_modules():
        if isinstance(module, LoraLayer):
            yield name, module


def adapter_names(model: nn.Module) -> list[str]:
    """Every adapter currently resident in the model."""
    for _, layer in lora_layers(model):
        return list(layer.lora_A.keys())
    return []


def set_active_adapter(model: nn.Module, name: str) -> None:
    """Switch which resident adapter is applied.

    No allocation and no tree surgery -- the tensors for every adapter are
    already in memory, this only moves a pointer. That is what makes runtime
    swapping cheap enough to do between requests.
    """
    available = adapter_names(model)
    if name not in available:
        raise ValueError(f"adapter {name!r} is not loaded -- have {available}")
    for _, layer in lora_layers(model):
        layer.set_adapter(name)


def set_lora_enabled(model: nn.Module, enabled: bool) -> None:
    """Turn every adapter branch on or off.

    Disabled is exactly the base model, so "no adapter" is a selectable option
    in the UI without reloading 500MB of weights.
    """
    for _, layer in lora_layers(model):
        layer.enable_adapters(enabled)


def lora_parameters(model: nn.Module) -> list[nn.Parameter]:
    """The parameters to hand the optimizer.

    Passing model.parameters() instead would allocate AdamW moment buffers for
    ~163M frozen tensors and hide a broken freeze behind a run that looks like
    it is working.
    """
    return [p for p in model.parameters() if p.requires_grad]


def trainable_summary(model: nn.Module) -> tuple[int, int]:
    """(trainable, total) parameter counts."""
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return trainable, total


def save_adapter(
    model: nn.Module,
    directory: str | Path,
    config: LoraConfig,
    meta: AdapterMeta,
    adapter_name: str = DEFAULT_ADAPTER,
) -> Path:
    """Write one adapter -- never the base weights, which is the point.

    safetensors rather than torch.save: adapters are small enough to fetch
    from a hub at request time, and a .pth is a pickle, so loading one is
    arbitrary code execution. safetensors is a dumb tensor container.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    state = get_peft_model_state_dict(model, adapter_name=adapter_name)
    save_file(
        {k: v.detach().cpu().contiguous() for k, v in state.items()},
        str(directory / ADAPTER_WEIGHTS),
    )
    config.save_pretrained(str(directory))
    (directory / ADAPTER_META).write_text(json.dumps(asdict(meta), indent=2) + "\n")
    return directory


def load_adapter_meta(directory: str | Path) -> AdapterMeta:
    path = Path(directory) / ADAPTER_META
    if not path.exists():
        return AdapterMeta()
    return AdapterMeta(**json.loads(path.read_text()))


def load_adapter(
    model: nn.Module,
    directory: str | Path,
    adapter_name: str = DEFAULT_ADAPTER,
    device: str | torch.device = "cpu",
) -> tuple[LoraConfig, AdapterMeta]:
    """Load an adapter into a model, injecting wrappers first if it has none.

    Returns the adapter's config and metadata so the caller can check the
    prompt format it was trained with against the one the engine is about to
    render -- a mismatch there degrades quality silently rather than raising.
    """
    directory = Path(directory)
    config = LoraConfig.from_pretrained(str(directory))
    if adapter_name not in adapter_names(model):
        inject_lora(model, config, adapter_name=adapter_name)
    state = load_file(str(directory / ADAPTER_WEIGHTS), device=str(device))
    result = set_peft_model_state_dict(model, state, adapter_name=adapter_name)
    if result.unexpected_keys:
        raise ValueError(
            f"adapter does not match the injected wrappers -- "
            f"unexpected={sorted(result.unexpected_keys)[:4]}"
        )
    return config, load_adapter_meta(directory)
