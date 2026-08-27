from queue import Queue
from threading import Event, Thread

import torch
from transformers import (
    AutoModelForCausalLM,
    AutoModelForImageTextToText,
    AutoTokenizer,
    TextIteratorStreamer,
    StoppingCriteria,
    StoppingCriteriaList,
)

from .base import Engine, GenerationParams

# most models here are plain causal LMs; Qwen3.5 is a vision-language model
# under a different AutoModel class even when used text-only (its
# architecture, Qwen3_5ForConditionalGeneration, isn't in
# AutoModelForCausalLM's mapping at all -- confirmed directly, not assumed).
# Selected per-model by registry.py, by string tag rather than importing a
# transformers class into registry.py.
_MODEL_CLASSES = {
    "causal_lm": AutoModelForCausalLM,
    "image_text_to_text": AutoModelForImageTextToText,
}


class _StopEventCriteria(StoppingCriteria):
    """Bridges our GenerationParams.stop_event into transformers' generate()
    loop -- generate() calls this after every token; returning True halts it.
    Without this, breaking the consuming `for text_chunk in streamer` loop
    does NOT stop the background thread's model.generate() call, which keeps
    running to max_new_tokens regardless and keeps burning CPU."""

    def __init__(self, stop_event: Event):
        self.stop_event = stop_event

    def __call__(self, input_ids, scores, **kwargs) -> bool:
        return self.stop_event.is_set()


class HFEngine(Engine):
    supports_cache_toggle = False

    def __init__(
        self,
        model_id: str,
        device: str = "cpu",
        model_class: str = "causal_lm",
        dtype: str | None = None,
    ):
        auto_cls = _MODEL_CLASSES[model_class]
        # left unspecified (dtype=None), from_pretrained defaults to fp32 on
        # CPU regardless of the checkpoint's stored dtype -- fine for the two
        # small models this was always fine for, but Granite (~1.63B) at fp32
        # is ~6.5GB, more than this deploy box's total RAM. Load in the
        # checkpoint's native bf16 instead when a caller asks for it.
        kwargs = {"dtype": getattr(torch, dtype)} if dtype else {}
        self.model = auto_cls.from_pretrained(model_id, **kwargs)
        self.tokenizer= AutoTokenizer.from_pretrained(model_id)
        self.model.eval()
        self.model.to(device)
        self.device = device

    def stream(self , params : GenerationParams):
        message = params.history + [{"role": "user", "content": params.prompt}]
        text = self.tokenizer.apply_chat_template(message,
                                                  tokenize = False ,
                                                  add_generation_prompt = True)
        inputs = self.tokenizer(text, return_tensors="pt").to(self.device)

        streamer = TextIteratorStreamer(self.tokenizer,
                                        skip_special_tokens = True,
                                        skip_prompt=True)
        kwargs = dict(
            **inputs,
            max_new_tokens=params.max_new_tokens,
            temperature=params.temperature,
            top_k=params.top_k,
            do_sample=True,
            streamer=streamer,
            stopping_criteria=StoppingCriteriaList([_StopEventCriteria(params.stop_event)]),
        )

        # errors raised inside model.generate() happen on the background thread;
        # hand them back through a queue rather than an instance attribute, since
        # self._error would be shared/clobbered across concurrent sessions
        errors: Queue = Queue()
        thread = Thread(target=self._generate, kwargs=kwargs, args=(errors,))
        thread.start()

        response = ""
        for text_chunk in streamer:
            if params.stop_event.is_set():
                break
            response += text_chunk
            yield text_chunk

        thread.join()
        if not errors.empty():
            raise errors.get()

    def _generate(self, errors: Queue, **kwargs):
        try:
            self.model.generate(**kwargs)
        except Exception as e:
            errors.put(e)

    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.model.parameters())


