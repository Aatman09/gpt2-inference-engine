"""Model-agnostic serving interface.

Every backend (my own KV-cache GPT-2, HuggingFace transformers models) is exposed
as an Engine that streams response text one chunk at a time, given the same
GenerationParams shape. The server layer measures latency by timing the gaps
between yields, so engines stay concerned only with generation, not instrumentation.

All three models (GPT-2, Qwen2.5-0.5B-Instruct, SmolLM2-360M-Instruct) are treated
as chat models: stream() takes a prompt plus a session_id and each engine keeps its
own per-session turn history. GPT-2 is pretrained/base today, not finetuned, so its
"chat" turns are just concatenated text it continues from rather than instruction-
following in the true sense -- but the interface is intentionally identical so an
instruction-tuned GPT-2 checkpoint can be swapped in later with no interface change.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Iterator


@dataclass
class GenerationParams:
    prompt: str
    session_id: str
    max_new_tokens: int = 128
    temperature: float = 0.8
    top_k: int | None = 50
    # Only meaningful for engines that report supports_cache_toggle=True.
    use_cache: bool = True


class Engine(ABC):
    """A loaded model that can stream a chat completion, per-session."""

    # Human-readable label shown in the UI model switcher.
    display_name: str = ""

    # True only for engines where disabling the KV cache is a real code path
    # rather than a silently ignored flag.
    supports_cache_toggle: bool = False

    @abstractmethod
    def stream(self, params: GenerationParams) -> Iterator[str]:
        """Yield decoded text deltas, one per generated token."""

    @abstractmethod
    def parameter_count(self) -> int:
        """Total parameters, used to report model size in the metrics panel."""
