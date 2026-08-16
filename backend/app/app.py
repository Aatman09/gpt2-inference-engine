import sys
import time
import json
from pathlib import Path
from threading import Event

# Point to project root where model_kv.py lives
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

import torch
from fastapi import FastAPI, HTTPException, status
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager

from .schemas import HealthResponse, PredictRequests, StopRequest
from .engine.base import GenerationParams
from .engine.registry import EngineRegistry

from fastapi.middleware.cors import CORSMiddleware

device = "cuda" if torch.cuda.is_available() else "cpu"

registry = EngineRegistry(device=device)

# session_id -> stop_event for whichever /generate call is currently in
# flight for that session, so /stop can find and signal the right one.
# Only one generation per session_id is expected at a time (the frontend
# disables the composer while streaming), so a plain dict is enough --
# no need to track a list of concurrent requests per session.
_active_generations: dict[str, Event] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    registry.preload()
    yield
    if device == "cuda":
        torch.cuda.empty_cache()

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"])

@app.get("/health", response_model=HealthResponse, status_code=status.HTTP_200_OK)
def health():
    loaded = registry.loaded_models()
    return HealthResponse(status="ok", model_loaded=bool(loaded), loaded_models=loaded)


def _sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _generate_events(engine, params: GenerationParams):
    start = time.perf_counter()
    first_token_time = None
    token_count = 0

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    try:
        for text_chunk in engine.stream(params):
            now = time.perf_counter()
            if first_token_time is None:
                first_token_time = now
            token_count += 1

            elapsed_since_first_token = now - first_token_time
            tokens_per_sec = (
                (token_count - 1) / elapsed_since_first_token if elapsed_since_first_token > 0 else 0.0
            )

            yield _sse_event({
                "type": "token",
                "text": text_chunk,
                "ttft_ms": (first_token_time - start) * 1000,
                "tokens_per_sec": tokens_per_sec,
            })
    except Exception as e:
        # the request already returned 200 with a streaming body, so a failure
        # can't become an HTTP error status -- surface it as a frame instead so
        # the client doesn't just see the stream go silent mid-response
        yield _sse_event({"type": "error", "message": str(e)})
        return

    if device == "cuda":
        peak_memory_mb = torch.cuda.max_memory_allocated() / (1024 ** 2)
    else:
        import resource
        # ru_maxrss is KB on Linux, bytes on macOS -- Spaces runs Linux
        peak_memory_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    total_time = time.perf_counter() - start
    yield _sse_event({
        "type": "done",
        "total_tokens": token_count,
        "total_time_s": total_time,
        "peak_memory_mb": peak_memory_mb,
        "cache_used": params.use_cache and engine.supports_cache_toggle,
    })


def _tracked_generate_events(engine, params: GenerationParams):
    _active_generations[params.session_id] = params.stop_event
    try:
        yield from _generate_events(engine, params)
    finally:
        # only clear if we're still the current holder -- a fast-follow
        # request for the same session_id could have already overwritten
        # this entry with a new stop_event by the time we get here
        if _active_generations.get(params.session_id) is params.stop_event:
            del _active_generations[params.session_id]


@app.post("/generate")
def generate(request: PredictRequests):
    try:
        engine = registry.get(request.model_name.value)
    except KeyError as e:
        raise HTTPException(status_code=400, detail=str(e))

    params = GenerationParams(
        prompt=request.predict,
        session_id=request.session_id,
        max_new_tokens=request.max_new_tokens,
        temperature=request.temprature,
        top_k=request.top_k,
        use_cache=request.use_cache,
    )

    return StreamingResponse(
        _tracked_generate_events(engine, params),
        media_type="text/event-stream",
    )


@app.post("/stop")
def stop(request: StopRequest):
    stop_event = _active_generations.get(request.session_id)
    if stop_event is None:
        return {"stopped": False, "reason": "no generation in progress for this session"}
    stop_event.set()
    return {"stopped": True}
