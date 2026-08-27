"""model_name -> Engine lookup, replacing app.py's bare my_models dict.

GPT-2 is eager-loaded at startup (cheap, always the default). The HF-backed
models are lazy-loaded on first request and cached after that -- on a
CPU-only, 4GB-RAM deploy box there's no reason to pay the load cost (or the
memory) for a model nobody has asked for yet in this process's lifetime.
"""
from .base import Engine
from .gpt_kv import GPTKVEngine
from .hfengine import HFEngine

# model_name (as sent by the client / ModelName enum) -> (engine class,
# constructor arg, extra kwargs for that engine class). The extras dict keeps
# this from growing another positional field every time a new engine needs a
# different knob -- adapter_name only means something to GPTKVEngine,
# model_class/dtype only to HFEngine, and an entry that needs neither just
# passes {}.
#
# "gpt2" means gpt2-medium plus the LoRA adapter trained in
# training/finetune_lora.py, not base gpt2 -- the API-facing name is
# unchanged so the frontend and persisted conversation history don't need to
# know it moved.
#
# Qwen3.5-0.8B loads at dtype=bfloat16 (~1.7GB, its checkpoint's native
# dtype) rather than HFEngine's fp32 default, and needs
# model_class="image_text_to_text": its real transformers class,
# Qwen3_5ForConditionalGeneration, isn't in AutoModelForCausalLM's mapping at
# all (confirmed directly) -- it's architecturally a vision-language model,
# used here text-only, which its own chat template and generate() already
# support with no image input required (verified end-to-end).
#
# Granite-4.0-1b was tried here and reverted: correct output, but at
# ~1.63B params it's ~3.26GB even at bf16, and gpt2-medium alone already
# measured ~3.3GB peak on this deploy's 4GB box -- the two can't be
# resident together, and loading Granite OOM-killed the whole container
# (gpt2 included, not just that request) rather than failing gracefully.
# Revisit if the box is resized.
_ENGINE_SPECS: dict[str, tuple[type[Engine], str, dict]] = {
    "gpt2": (GPTKVEngine, "gpt2-medium", {"adapter_name": "gpt2-medium-instruct"}),
    "qwen3.5-0.8b": (HFEngine, "Qwen/Qwen3.5-0.8B",
                      {"model_class": "image_text_to_text", "dtype": "bfloat16"}),
    "smollm2-360m-instruct": (HFEngine, "HuggingFaceTB/SmolLM2-360M-Instruct", {}),
}

EAGER_LOAD = ("gpt2",)


class EngineRegistry:
    def __init__(self, device: str = "cpu"):
        self.device = device
        self._loaded: dict[str, Engine] = {}

    def preload(self) -> None:
        for model_name in EAGER_LOAD:
            self.get(model_name)

    """Returns the object of the model - varible used is engine"""
    def get(self, model_name: str) -> Engine:
        engine = self._loaded.get(model_name)
        if engine is not None:
            return engine

        if model_name not in _ENGINE_SPECS:
            raise KeyError(f"Unknown model_name: {model_name!r}")

        engine_cls, model_id, extra_kwargs = _ENGINE_SPECS[model_name]
        engine = engine_cls(model_id, device=self.device, **extra_kwargs)

        self._loaded[model_name] = engine
        return engine

    def loaded_models(self) -> list[str]:
        return list(self._loaded.keys())
