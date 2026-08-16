from queue import Queue
from threading import Event, Thread

from transformers import AutoModelForCausalLM , AutoTokenizer , TextIteratorStreamer , StoppingCriteria , StoppingCriteriaList

from .base import Engine, GenerationParams


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

    def __init__(self, model_id : str):
        self.model = AutoModelForCausalLM.from_pretrained(model_id)
        self.tokenizer= AutoTokenizer.from_pretrained(model_id)
        self.model.eval()

    def stream(self , params : GenerationParams):
        message = params.history + [{"role": "user", "content": params.prompt}]
        text = self.tokenizer.apply_chat_template(message,
                                                  tokenize = False ,
                                                  add_generation_prompt = True)
        inputs = self.tokenizer(text, return_tensors="pt")

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


