"""Model-agnostic serving interface.

Every backend (my own KV-cache GPT-2, HuggingFace transformers models) is exposed
as an Engine that streams response text one chunk at a time, given the same
GenerationParams shape. The server layer measures latency by timing the gaps
between yields, so engines stay concerned only with generation, not instrumentation.

All three models (GPT-2, Qwen2.5-0.5B-Instruct, SmolLM2-360M-Instruct) are treated
as chat models: stream() takes a prompt plus prior turns (`history`). GPT-2 is
pretrained/base today, not finetuned, so its "chat" turns are just concatenated
text it continues from rather than instruction-following in the true sense --
but the interface is intentionally identical so an instruction-tuned GPT-2
checkpoint can be swapped in later with no interface change.

History lives in Postgres (see docs/ROADMAP.md Phase 1/2), not in the engine.
The route handler loads a conversation's `messages` before calling stream() and
persists the new turns after -- engines are stateless with respect to history,
which also fixes a real bug the old per-engine in-memory dicts had: since
EngineRegistry caches one engine instance per model, the same session_id under
two different models used to see two unrelated histories.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from threading import Event
from typing import Iterator


@dataclass
class GenerationParams:
    prompt: str
    session_id: str
    # prior turns, e.g. [{"role": "user", "content": ...}, {"role": "assistant", ...}],
    # loaded from Postgres by the route handler before stream() is called
    history: list[dict] = field(default_factory=list)
    max_new_tokens: int = 128
    temperature: float = 0.8
    top_k: int | None = 50
    # Only meaningful for engines that report supports_cache_toggle=True.
    use_cache: bool = True
    # Set by the route handler when the client disconnects (stop button, tab
    # close, etc). Engines must check this each loop iteration so a cancelled
    # request actually frees the CPU instead of running to max_new_tokens
    # regardless -- the free HF Spaces tier can't afford to burn cycles on
    # generations nobody is reading anymore. default_factory=Event, not
    # Event(), because a bare mutable default would be one Event shared
    # across every GenerationParams instance -- cancelling user A's request
    # would silently cancel user B's too.
    stop_event: Event = field(default_factory=Event)


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
