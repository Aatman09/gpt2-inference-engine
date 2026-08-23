"""model_name -> Engine lookup, replacing app.py's bare my_models dict.

GPT-2 is eager-loaded at startup (cheap, always the default). Qwen and SmolLM2
are lazy-loaded on first request and cached after that -- on the free HF Spaces
CPU tier there's no reason to pay the load cost for a model nobody asked for.
"""
from .base import Engine
from .gpt_kv import GPTKVEngine
from .hfengine import HFEngine

# model_name (as sent by the client / ModelName enum) -> (engine class, constructor arg)
_ENGINE_SPECS: dict[str, tuple[type[Engine], str]] = {
    "gpt2": (GPTKVEngine, "gpt2"),
    "qwen2.5-0.5b-instruct": (HFEngine, "Qwen/Qwen2.5-0.5B-Instruct"),
    "smollm2-360m-instruct": (HFEngine, "HuggingFaceTB/SmolLM2-360M-Instruct"),
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

        engine_cls, model_id = _ENGINE_SPECS[model_name]
        engine = engine_cls(model_id, device=self.device)

        self._loaded[model_name] = engine
        return engine

    def loaded_models(self) -> list[str]:
        return list(self._loaded.keys())
