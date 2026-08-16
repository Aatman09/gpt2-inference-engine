from sqlalchemy import String, DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession, create_async_engine

import uuid
from datetime import datetime
from pathlib import Path
from starlette.config import Config

# load DATABASE_URL from the .env sitting next to this file, regardless of CWD
config = Config(str(Path(__file__).resolve().parent / ".env"))


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    """Phase 1 (see docs/ROADMAP.md): one row per conversation, JSONB message
    array -- document-store pattern inside Postgres, no separate DB. No user
    scoping yet; that's Phase 3 (auth), deliberately deferred."""

    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), default="New chat")
    messages: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # server_onupdate is NOT a real auto-update mechanism in plain Postgres --
    # it only tells SQLAlchemy to re-read the column after an UPDATE, it doesn't
    # make Postgres compute one (no native ON UPDATE clause, unlike MySQL).
    # onupdate=func.now() is client-side: SQLAlchemy sets it on every UPDATE
    # *it* issues, which is fine since all writes to this table go through the app.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


DATABASE_URL = config("DATABASE_URL")
engine = create_async_engine(DATABASE_URL)

# expire_on_commit=False: keep loaded attributes usable after commit() without
# an extra round-trip -- routes return the object's fields in the response
# right after committing, so refetching on every access would be wasted work
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with async_session() as session:
        yield session
