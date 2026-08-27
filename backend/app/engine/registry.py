"""model_name -> Engine lookup, replacing app.py's bare my_models dict.

GPT-2 is eager-loaded at startup (cheap, always the default). Qwen and SmolLM2
are lazy-loaded on first request and cached after that -- on the free HF Spaces
CPU tier there's no reason to pay the load cost for a model nobody asked for.
"""
from .base import Engine
from .gpt_kv import GPTKVEngine
from .hfengine import HFEngine

# model_name (as sent by the client / ModelName enum) -> (engine class,
# constructor arg, adapter name under repo-root adapters/, or None for base).
# "gpt2" now means gpt2-medium plus the LoRA adapter trained in
# training/finetune_lora.py -- the API-facing name is unchanged so the
# frontend and persisted conversation history don't need to know it moved.
_ENGINE_SPECS: dict[str, tuple[type[Engine], str, str | None]] = {
    "gpt2": (GPTKVEngine, "gpt2-medium", "gpt2-medium-instruct"),
    "qwen2.5-0.5b-instruct": (HFEngine, "Qwen/Qwen2.5-0.5B-Instruct", None),
    "smollm2-360m-instruct": (HFEngine, "HuggingFaceTB/SmolLM2-360M-Instruct", None),
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

        engine_cls, model_id, adapter_name = _ENGINE_SPECS[model_name]
        # adapter_name only means something to GPTKVEngine -- HFEngine takes
        # no such argument, so it's passed conditionally rather than adding a
        # parameter every engine has to ignore
        kwargs = {"device": self.device}
        if adapter_name is not None:
            kwargs["adapter_name"] = adapter_name
        engine = engine_cls(model_id, **kwargs)

        self._loaded[model_name] = engine
        return engine

    def loaded_models(self) -> list[str]:
        return list(self._loaded.keys())
