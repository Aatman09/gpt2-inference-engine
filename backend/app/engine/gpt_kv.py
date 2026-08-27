"""Engine wrapping model_kv.GPT -- the hand-written KV-cache GPT-2.

GPT-2 has no chat template, so history is rendered into one flat "User: ...\\n
Assistant: ...\\n" string before encoding. This keeps the same history shape as
HFEngine, so an instruction-tuned GPT-2 checkpoint can be dropped in later
without touching this interface.

use_cache=False takes the naive path: re-run forward() on the whole sequence
so far at every step, passing no cache, so the ON/OFF toggle produces a real
speed difference rather than a flag that's silently ignored.
"""
from pathlib import Path

import tiktoken
import torch
import torch.nn.functional as F
from peft import LoraConfig, inject_adapter_in_model, set_peft_model_state_dict
from safetensors.torch import load_file

from model_kv import GPT
from .base import Engine, GenerationParams

# tiktoken's gpt2 encoding only has 50257 real tokens; model_kv.py pads
# vocab_size to 50304 for tensor-core alignment, and the extra rows are
# never-trained random init. Sampling has to mask them out or tiktoken.decode
# raises KeyError the first time one gets sampled.
REAL_VOCAB_SIZE = 50257
EOT_TOKEN = 50256

# GPT-2's learned position embedding table (wpe) has exactly this many rows,
# so prompt + generated tokens can never exceed it.
BLOCK_SIZE = 1024

# gpt_kv.py -> engine/ -> app/ -> backend/ -> repo root, where training's
# finetune_lora.py writes adapters/<name>/
ADAPTERS_ROOT = Path(__file__).resolve().parent.parent.parent.parent / "adapters"


class GPTKVEngine(Engine):
    supports_cache_toggle = True

    def __init__(self, model_type: str, device: str = "cpu", adapter_name: str | None = None):
        self.enc = tiktoken.get_encoding("gpt2")
        self.model = GPT.from_pretrained(model_type)
        self.model.eval()
        self.model.to(device)
        self.device = device

        if adapter_name is not None:
            self._load_adapter(adapter_name)

    def _load_adapter(self, adapter_name: str) -> None:
        """Inject a trained LoRA adapter and load its weights.

        Base weights must already be loaded and moved to device -- injection
        replaces each targeted nn.Linear with a wrapper holding the original
        at .base_layer, and peft creates the new lora_A/lora_B parameters
        matching whatever device/dtype the base layer already has.
        """
        directory = ADAPTERS_ROOT / adapter_name
        config = LoraConfig.from_pretrained(str(directory))
        inject_adapter_in_model(config, self.model)

        # peft leaves freshly-injected wrappers in train mode regardless of
        # the model's mode beforehand, so lora_dropout stays live unless this
        # runs again after injection -- the same bug training/full/lora.py's
        # inject_lora works around. Missed here, generation is silently
        # non-deterministic.
        self.model.eval()

        state = load_file(str(directory / "adapter_model.safetensors"), device=str(self.device))
        result = set_peft_model_state_dict(self.model, state)
        if result.unexpected_keys:
            raise ValueError(
                f"adapter {adapter_name!r} does not match the injected wrappers -- "
                f"unexpected keys: {result.unexpected_keys[:4]}"
            )

    """takes the history (passed in via GenerationParams, loaded from Postgres
        by the route handler) which looks like [{"role":, "content":}, ...],
        renders each turn as "Role: content\\n", then adds User: <prompt>
        Assistant: at the end and sends this string"""
    def _render_prompt(self, history: list[dict], prompt: str) -> str:
        rendered = "".join(
            f"{turn['role'].capitalize()}: {turn['content']}\n" for turn in history
        )
        rendered += f"User: {prompt}\nAssistant:"
        return rendered

    """Used to sample out token one at a time , it takes the  logits vector  divides by temprature to
       generate randomness , and then take the top_k chunks and from the top_k chunk returns the first 
       one"""
    def _sample(self, logits: torch.Tensor, temperature: float, top_k: int | None) -> torch.Tensor:
        logits = logits[:, -1, :].clone()
        logits[:, REAL_VOCAB_SIZE:] = -float("inf")
        logits = logits / temperature
        if top_k is not None:
            v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
            logits[logits < v[:, [-1]]] = -float("inf")
        probs = F.softmax(logits, dim=-1)
        return torch.multinomial(probs, num_samples=1)
    """"""
    def stream(self, params: GenerationParams):
        prompt_text = self._render_prompt(params.history, params.prompt)
        tokens = self.enc.encode(prompt_text, allowed_special={"<|endoftext|>"})

        # wpe only has BLOCK_SIZE rows, and positions keep counting up as we
        # decode -- so the prompt has to leave room for every token we're
        # about to generate. Keep the TAIL of the prompt: the most recent
        # turns matter more than the oldest ones, and the trailing
        # "User: ...\nAssistant:" scaffold has to survive or the model has no
        # cue to answer. (Proper history summarisation is Phase 5 in
        # docs/ROADMAP.md; this is the guard that stops it crashing today.)
        max_prompt_tokens = BLOCK_SIZE - params.max_new_tokens
        if max_prompt_tokens <= 0:
            raise ValueError(
                f"max_new_tokens={params.max_new_tokens} leaves no room for a prompt "
                f"within GPT-2's {BLOCK_SIZE}-token context window"
            )
        if len(tokens) > max_prompt_tokens:
            tokens = tokens[-max_prompt_tokens:]

        idx = torch.tensor(tokens, dtype=torch.long, device=self.device).unsqueeze(0)

        response_tokens: list[int] = []

        with torch.no_grad():
            if params.use_cache:
                logits, kv_caches, _ = self.model(idx)
                for _ in range(params.max_new_tokens):
                    if params.stop_event.is_set():
                        break
                    next_token = self._sample(logits, params.temperature, params.top_k)
                    token_id = next_token.item()
                    if token_id == EOT_TOKEN:
                        break
                    response_tokens.append(token_id)
                    yield self.enc.decode([token_id])
                    logits, kv_caches, _ = self.model(next_token, kv_caches)
            else:
                # naive path: no cache carried between steps, re-run the full
                # sequence-so-far every time -- this is the slow comparison arm
                for _ in range(params.max_new_tokens):
                    if params.stop_event.is_set():
                        break
                    logits, _, _ = self.model(idx)
                    next_token = self._sample(logits, params.temperature, params.top_k)
                    token_id = next_token.item()
                    if token_id == EOT_TOKEN:
                        break
                    response_tokens.append(token_id)
                    yield self.enc.decode([token_id])
                    idx = torch.cat([idx, next_token], dim=1)

    """Usesd to count the total_parameters in the model"""
    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.model.parameters())
