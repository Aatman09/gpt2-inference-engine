# --- Stage 1: build the frontend ---
FROM node:22-slim AS frontend

WORKDIR /build

# package files first so npm ci is cached unless dependencies actually change
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# --- Stage 2: the app ---
FROM python:3.11-slim

# HF Spaces runs the container as a non-root user with UID 1000, and the
# HF Hub cache must be writable for model downloads to work at runtime.
RUN useradd -m -u 1000 appuser

WORKDIR /app

# uv resolves and installs far faster than pip, and the lockfile is already
# in the repo
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# dependency manifests first, so the (slow, ~2GB torch) install layer is
# cached unless the dependencies themselves change
COPY backend/pyproject.toml backend/uv.lock ./backend/
RUN cd backend && uv sync --frozen --no-dev

# model_kv.py lives at the repo root and is imported by the engine
COPY model_kv.py ./
COPY backend/ ./backend/

# the built SPA, served by FastAPI at runtime (see FRONTEND_DIST in app.py)
COPY --from=frontend /build/dist ./backend/static

ENV PATH="/app/backend/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    ENVIRONMENT=production \
    # HF Spaces' only writable location for the model cache
    HF_HOME=/app/.cache/huggingface

RUN mkdir -p /app/.cache/huggingface && chown -R appuser:appuser /app

USER appuser

# HF Spaces routes traffic to 7860
EXPOSE 7860

# migrations run at startup so a fresh database gets its schema without a
# manual step; `upgrade head` is a no-op when already current
CMD ["sh", "-c", "cd /app/backend && alembic upgrade head && uvicorn app.app:app --host 0.0.0.0 --port 7860"]
