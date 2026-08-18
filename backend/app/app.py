import asyncio
import sys
import time
import json
from pathlib import Path
from threading import Event

# Point to project root where model_kv.py lives
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

import torch
from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from .schemas import (
    HealthResponse,
    PredictRequests,
    StopRequest,
    ConversationSummary,
    Conversation as ConversationSchema,
    CreateConversationRequest,
    AppendMessageRequest,
    RenameConversationRequest,
    SignupRequest,
    LoginRequest,
    UserResponse,
)
from .database import Conversation, User, get_db
from .auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    COOKIE_NAME,
)
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
    allow_headers=["*"],
    # required for the browser to actually send/accept the httpOnly JWT
    # cookie across the :5173 (Vite) / :8010 (FastAPI) origin split in dev
    allow_credentials=True)

@app.get("/health", response_model=HealthResponse, status_code=status.HTTP_200_OK)
def health():
    loaded = registry.loaded_models()
    return HealthResponse(status="ok", model_loaded=bool(loaded), loaded_models=loaded)


# --- Phase 3: auth (see docs/ROADMAP.md) ---
# Single JWT access-token cookie, no refresh-token rotation -- a deliberate
# scope cut for a single-demo-account portfolio app, not a gap (see
# ROADMAP.md's Phase 3 section for the full reasoning).

def _set_auth_cookie(response: Response, user_id) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=create_access_token(user_id),
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 60 * 60,
    )


@app.post("/auth/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def signup(request: SignupRequest, response: Response, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(User).where(User.email == request.email))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(z=409, detail="Email already registered")

    user = User(
        email=request.email,
        name=request.name,
        password=hash_password(request.password),
        auth_provider="local",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    _set_auth_cookie(response, user.id)
    return user


@app.post("/auth/login", response_model=UserResponse)
async def login(request: LoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == request.email))
    user = result.scalar_one_or_none()

    # same generic error whether the email doesn't exist or the password is
    # wrong -- distinguishing them lets an attacker enumerate real emails
    invalid_credentials = HTTPException(status_code=401, detail="Invalid email or password")
    if user is None or user.password is None:
        raise invalid_credentials
    if not verify_password(request.password, user.password):
        raise invalid_credentials

    _set_auth_cookie(response, user.id)
    return user


@app.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@app.get("/auth/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)):
    return user


def _sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _generate_events(engine, params: GenerationParams):
    """Streams SSE frames and returns the full assistant reply via StopIteration.value
    (yield-from-generator's way of returning a value) -- app.py needs the complete
    text afterward to persist it, but the generator protocol only has yields, so a
    plain `return response_text` here is what a `yield from` caller downstream can
    retrieve as `.value`."""
    start = time.perf_counter()
    first_token_time = None
    token_count = 0
    response_text = ""

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    try:
        for text_chunk in engine.stream(params):
            now = time.perf_counter()
            if first_token_time is None:
                first_token_time = now
            token_count += 1
            response_text += text_chunk

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
        return response_text

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
    return response_text


async def _tracked_generate_events(engine, params: GenerationParams, db: AsyncSession, conversation: Conversation):
    _active_generations[params.session_id] = params.stop_event
    response_text = ""
    try:
        # _generate_events is sync and CPU-bound: every next() runs a full model
        # forward pass. Calling it directly from this async generator would block
        # the event loop for the whole generation, so chunks pile up instead of
        # being flushed to the socket as they're produced (bursty streaming), and
        # every other request stalls too. Run it on a worker thread and hand
        # chunks back through a queue so the loop stays free to flush each frame.
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        _DONE = object()

        def pump():
            gen = _generate_events(engine, params)
            try:
                while True:
                    try:
                        chunk = next(gen)
                    except StopIteration as stop:
                        loop.call_soon_threadsafe(queue.put_nowait, (_DONE, stop.value or ""))
                        return
                    loop.call_soon_threadsafe(queue.put_nowait, (chunk, None))
            except BaseException as e:  # noqa: BLE001 - relayed to the consumer below
                loop.call_soon_threadsafe(queue.put_nowait, (_DONE, e))

        task = loop.run_in_executor(None, pump)
        try:
            while True:
                chunk, payload = await queue.get()
                if chunk is _DONE:
                    if isinstance(payload, BaseException):
                        raise payload
                    response_text = payload
                    break
                yield chunk
        finally:
            await task
    finally:
        if _active_generations.get(params.session_id) is params.stop_event:
            del _active_generations[params.session_id]

    # persist only if something was actually generated -- an immediate stop
    # (stop_event set before the first token) leaves nothing worth saving
    if response_text:
        conversation.messages = [
            *conversation.messages,
            {"role": "user", "content": params.prompt},
            {"role": "assistant", "content": response_text},
        ]
        await db.commit()


@app.post("/generate")
async def generate(
    request: PredictRequests,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        engine = registry.get(request.model_name.value)
    except KeyError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        conversation_id = UUID(request.session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="session_id must be a conversation UUID")

    conversation = await db.get(Conversation, conversation_id)
    # 404, not 403, whether the row doesn't exist or belongs to someone else --
    # a 403 would confirm the id is real, leaking which conversation ids exist
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    params = GenerationParams(
        prompt=request.predict,
        session_id=request.session_id,
        history=conversation.messages,
        max_new_tokens=request.max_new_tokens,
        temperature=request.temprature,
        top_k=request.top_k,
        use_cache=request.use_cache,
    )

    return StreamingResponse(
        _tracked_generate_events(engine, params, db, conversation),
        media_type="text/event-stream",
        headers={
            # stops intermediary buffering from batching up SSE frames --
            # nginx (and other proxies) buffer text/event-stream by default,
            # which would undo the per-token flushing above
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


@app.post("/stop")
async def stop(
    request: StopRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        conversation_id = UUID(request.session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="session_id must be a conversation UUID")

    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    stop_event = _active_generations.get(request.session_id)
    if stop_event is None:
        return {"stopped": False, "reason": "no generation in progress for this session"}
    stop_event.set()
    return {"stopped": True}


# --- Phase 1: conversation persistence (see docs/ROADMAP.md) ---
# Phase 3: every route below is now ownership-checked against the
# authenticated user.

async def _get_conversation_or_404(conversation_id: UUID, db: AsyncSession, user: User) -> Conversation:
    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.get("/conversations", response_model=list[ConversationSummary])
async def list_conversations(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    result = await db.execute(
        select(Conversation).where(Conversation.user_id == user.id).order_by(Conversation.updated_at.desc())
    )
    return result.scalars().all()


@app.post("/conversations", response_model=ConversationSchema, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    request: CreateConversationRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conversation = Conversation(title=request.title or "New chat", user_id=user.id)
    db.add(conversation)
    await db.commit()
    # see append_message's comment: server-computed columns need an explicit
    # refresh before FastAPI's response_model serialization touches them
    await db.refresh(conversation)
    return conversation


@app.get("/conversations/{conversation_id}", response_model=ConversationSchema)
async def get_conversation(
    conversation_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    return await _get_conversation_or_404(conversation_id, db, user)


@app.patch("/conversations/{conversation_id}", response_model=ConversationSchema)
async def rename_conversation(
    conversation_id: UUID,
    request: RenameConversationRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conversation = await _get_conversation_or_404(conversation_id, db, user)
    conversation.title = request.title
    await db.commit()
    # see append_message: server-computed updated_at needs an explicit refresh
    # before response_model serialization touches it
    await db.refresh(conversation)
    return conversation


@app.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    conversation = await _get_conversation_or_404(conversation_id, db, user)
    await db.delete(conversation)
    await db.commit()


@app.post("/conversations/{conversation_id}/messages", response_model=ConversationSchema)
async def append_message(
    conversation_id: UUID,
    request: AppendMessageRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conversation = await _get_conversation_or_404(conversation_id, db, user)
    # reassign rather than .append() -- JSONB columns need a new list object
    # for SQLAlchemy's change-tracking to notice the mutation and emit an UPDATE
    conversation.messages = [*conversation.messages, {"role": request.role, "content": request.content}]
    await db.commit()
    # updated_at is server-computed (onupdate=func.now()), so after commit it's
    # marked stale and reading it lazily triggers async I/O outside the session's
    # greenlet context -- FastAPI's response_model serialization runs in that
    # unsafe context, so refresh explicitly here to load it while still inside
    # the awaited async session.
    await db.refresh(conversation)
    return conversation
