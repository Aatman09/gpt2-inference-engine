"""The one place the chat prompt format is defined.

Imported by BOTH the training data prep (training/prepare_sft.py) and the
serving engine (backend/app/engine/gpt_kv.py). Never copy these strings --
a training/serving format mismatch does not raise, it just silently destroys
quality, and it is the most common way a project like this fails.

The format:

    User: {instruction}\\nAssistant: {response}<|endoftext|>

Two details that are not arbitrary:

* No space after "Assistant:". tiktoken encodes "Assistant:" as [48902, 25]
  and the reply's first word carries its own leading space (" Paris" -> 6342).
  Adding a trailing space emits token 220, a standalone space that barely
  occurs in natural text, at the exact position where generation starts -- and
  the reply token still arrives with its own space, so you have also trained a
  doubled space.

* "<|endoftext|>" (50256) terminates every response. No new special tokens:
  50256 is free, and the engine already stops on it. Teaching the model to
  emit it is the clearest signal that instruction tuning worked -- a base
  GPT-2 never stops.

FORMAT_VERSION is written into every adapter's metadata. If you change
anything here, bump it: an adapter trained on v1 loads cleanly against a v2
renderer and generates garbage, and the version is the only way to tell.
"""

FORMAT_VERSION = "v1"

EOT = "<|endoftext|>"
EOT_TOKEN = 50256

USER_ROLE = "User"
ASSISTANT_ROLE = "Assistant"


def render_history(history: list[dict]) -> str:
    """Completed turns, each as "Role: content\\n".

    history is [{"role": "user"|"assistant", "content": str}, ...] -- the shape
    the route handler loads out of Postgres.
    """
    return "".join(
        f"{turn['role'].capitalize()}: {turn['content']}\n" for turn in history
    )


def render_prompt(history: list[dict], instruction: str) -> str:
    """The full string to encode at inference time.

    Ends on the bare "Assistant:" scaffold, which is the cue for the model to
    answer rather than to keep writing the conversation.
    """
    return f"{render_history(history)}{USER_ROLE}: {instruction}\n{ASSISTANT_ROLE}:"


def render_response(response: str) -> str:
    """The target half of a training example, terminator included.

    Split from the prompt half so data prep knows exactly where the loss mask
    starts. The leading space belongs here, not on the scaffold -- see the
    module docstring.
    """
    return f" {response.strip()}{EOT}"


def render_training_example(instruction: str, response: str) -> tuple[str, str]:
    """(prompt, response) for one single-turn SFT example.

    Returned as two strings rather than one so the caller can tokenize them
    separately and mask the prompt half out of the loss. Concatenated they are
    exactly what render_prompt produces at serving time, which is the property
    that keeps training and inference from drifting apart.
    """
    return render_prompt([], instruction), render_response(response)
