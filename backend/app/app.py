import asyncio
import os
import secrets
import sys
import time
import json
from pathlib import Path
from threading import Event

# Point to project root where model_kv.py lives
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

import torch
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
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
    google_authorize_url,
    new_oauth_state,
    exchange_google_code,
    find_or_create_google_user,
    COOKIE_NAME,
    OAUTH_STATE_COOKIE,
    GOOGLE_ENABLED,
)
from .engine.base import GenerationParams
from .engine.registry import EngineRegistry

from fastapi.middleware.cors import CORSMiddleware

device = "cuda" if torch.cuda.is_available() else "cpu"

# set in the deployed environment (HF Spaces) -- switches off dev-only CORS
# and turns on Secure cookies, which require HTTPS and so can't be used locally
IS_PRODUCTION = os.getenv("ENVIRONMENT", "development") == "production"

# the built frontend, copied in by the Dockerfile; absent in local dev, where
# Vite serves the UI on its own port instead
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "static"

# where the OAuth callback sends the browser once the session cookie is set.
# Empty in production makes the redirects site-relative ("/chat"), which is
# correct there because FastAPI serves the SPA itself; in dev the UI lives on
# Vite's separate origin and needs the absolute URL.
FRONTEND_ORIGIN = "" if IS_PRODUCTION else "http://localhost:5173"

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

# In production FastAPI serves the built frontend itself, so requests are
# same-origin and CORS isn't needed at all. It only exists for local dev,
# where Vite (:5173) and FastAPI (:8010) are separate origins.
if not IS_PRODUCTION:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
        # required for the browser to actually send/accept the httpOnly JWT
        # cookie across the origin split in dev
        allow_credentials=True)

@app.get("/health", response_model=HealthResponse, status_code=status.HTTP_200_OK)
def health():
    loaded = registry.loaded_models()
    return HealthResponse(
        status="ok",
        model_loaded=bool(loaded),
        loaded_models=loaded,
        google_enabled=GOOGLE_ENABLED,
    )


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
        # Secure requires HTTPS, so it can only be set in production -- on
        # plain-HTTP localhost the browser would silently drop the cookie
        secure=IS_PRODUCTION,
        max_age=7 * 24 * 60 * 60,
    )


@app.post("/auth/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def signup(request: SignupRequest, response: Response, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(User).where(User.email == request.email))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Email already registered")

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


@app.get("/auth/google/login")
async def google_login():
    """Redirect the browser to Google's consent screen.

    A GET returning a redirect, not a JSON API call, because the browser itself
    has to navigate to Google -- fetch() would hit CORS and couldn't show the
    consent UI anyway.
    """
    if not GOOGLE_ENABLED:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")

    state = new_oauth_state()
    response = RedirectResponse(google_authorize_url(state))
    # CSRF defence: Google echoes this value back to the callback, which
    # compares it against the cookie. Without it, an attacker could feed their
    # own callback URL to a victim and silently log them into the attacker's
    # account. Short-lived, since it only has to survive one round trip.
    response.set_cookie(
        key=OAUTH_STATE_COOKIE,
        value=state,
        httponly=True,
        # deliberately NOT "strict": the callback arrives as a cross-site
        # navigation from accounts.google.com, and a strict cookie would not be
        # sent on it -- breaking the very check it exists for
        samesite="lax",
        secure=IS_PRODUCTION,
        max_age=600,
    )
    return response


@app.get("/auth/google/callback")
async def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Google redirects the browser here after the consent screen."""
    if not GOOGLE_ENABLED:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")

    # the user hit "Cancel" on the consent screen, or Google refused
    if error or not code:
        return RedirectResponse(f"{FRONTEND_ORIGIN}/login?error=google_denied")

    # constant-time compare and a presence check: a missing cookie (expired, or
    # a forged callback that never went through /auth/google/login) fails just
    # as hard as a mismatched one
    expected_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not expected_state or not state or not secrets.compare_digest(state, expected_state):
        return RedirectResponse(f"{FRONTEND_ORIGIN}/login?error=invalid_state")

    try:
        profile = await exchange_google_code(code)
        user = await find_or_create_google_user(db, profile)
    except HTTPException:
        # surface failures in the UI rather than as a raw JSON error page --
        # the browser is mid-navigation here, not calling an API
        return RedirectResponse(f"{FRONTEND_ORIGIN}/login?error=google_failed")

    # land on the app itself: the session cookie is set on this same response,
    # so the SPA boots straight into an authenticated state
    response = RedirectResponse(f"{FRONTEND_ORIGIN}/chat")
    _set_auth_cookie(response, user.id)
    response.delete_cookie(OAUTH_STATE_COOKIE)
    return response


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
    """Streams SSE frames and returns (response_text, metrics) via StopIteration.value
    (yield-from-generator's way of returning a value) -- app.py needs the complete
    text and its measurements afterward to persist them, but the generator protocol
    only has yields, so a plain `return` here is what a `yield from` caller
    downstream can retrieve as `.value`.

    metrics is None when generation failed part-way: a partial reply gets no
    numbers rather than fabricated ones."""
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
        return response_text, None

    if device == "cuda":
        peak_memory_mb = torch.cuda.max_memory_allocated() / (1024 ** 2)
    else:
        import resource
        # ru_maxrss is KB on Linux, bytes on macOS -- Spaces runs Linux
        peak_memory_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    end = time.perf_counter()
    # the token frames carry rate/TTFT and the done frame used to carry only
    # memory/totals, so a client that replaced one with the other lost half the
    # numbers. The done frame now repeats every measurement: one metrics object
    # is what gets streamed, persisted, and rendered.
    elapsed_since_first_token = (end - first_token_time) if first_token_time else 0.0
    metrics = {
        "ttft_ms": (first_token_time - start) * 1000 if first_token_time else None,
        "tokens_per_sec": (
            (token_count - 1) / elapsed_since_first_token if elapsed_since_first_token > 0 else 0.0
        ),
        "total_tokens": token_count,
        "total_time_s": end - start,
        "peak_memory_mb": peak_memory_mb,
        "cache_used": params.use_cache and engine.supports_cache_toggle,
    }
    yield _sse_event({"type": "done", **metrics})
    return response_text, metrics


async def _tracked_generate_events(engine, params: GenerationParams, db: AsyncSession, conversation: Conversation):
    _active_generations[params.session_id] = params.stop_event
    response_text = ""
    metrics = None
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
                        loop.call_soon_threadsafe(queue.put_nowait, (_DONE, stop.value or ("", None)))
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
                    response_text, metrics = payload
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
        # metrics ride along in the JSONB message so a reload shows the same
        # numbers the reply showed live -- without this the engine receipt
        # only ever existed in the browser's memory for one session
        assistant_message = {"role": "assistant", "content": response_text}
        if metrics is not None:
            assistant_message["metrics"] = metrics
        conversation.messages = [
            *conversation.messages,
            {"role": "user", "content": params.prompt},
            assistant_message,
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
        # assistant rows also carry a persisted "metrics" key now; engines are
        # contracted on [{"role", "content"}] only (chat templates in
        # particular get handed these dicts verbatim), so strip it here
        history=[{"role": m["role"], "content": m["content"]} for m in conversation.messages],
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


# --- Serving the built frontend (production only) ---
# HF Spaces exposes a single port, so FastAPI serves the Vite build itself
# rather than running a separate static host. Mounted last so every API route
# above is matched first.

if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        """Serve real files where they exist, otherwise index.html.

        The frontend is a client-side-routed SPA: /chat and /settings don't
        exist as files, so a hard refresh on those paths has to return
        index.html and let react-router resolve the route in the browser.
        """
        candidate = (FRONTEND_DIST / full_path).resolve()
        # containment check -- stops "../.." style paths escaping the build dir
        if (
            full_path
            and FRONTEND_DIST in candidate.parents
            and candidate.is_file()
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
