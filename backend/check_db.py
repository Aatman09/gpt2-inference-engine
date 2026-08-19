"""Quick look at what's actually in the database DATABASE_URL points at.

    uv run python3 check_db.py
"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.database import DATABASE_URL  # noqa: E402

import asyncpg  # noqa: E402


async def main():
    # asyncpg wants a plain postgresql:// DSN and ssl as a kwarg, not the
    # SQLAlchemy-flavoured URL the app uses
    dsn = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://").split("?")[0]
    kwargs = {"ssl": "require"} if "neon.tech" in dsn else {}

    host = dsn.split("@")[-1].split("/")[0]
    print(f"connected to: {host}\n")

    conn = await asyncpg.connect(dsn, **kwargs)

    users = await conn.fetch(
        "SELECT id, email, name, auth_provider, created_at FROM users ORDER BY created_at"
    )
    print(f"users ({len(users)}):")
    for u in users:
        print(f"  {u['email']:32} {u['name']:20} {u['auth_provider']:6} {u['created_at']:%Y-%m-%d %H:%M}")

    convs = await conn.fetch(
        """SELECT c.title, c.updated_at, u.email, jsonb_array_length(c.messages) AS msgs
           FROM conversations c JOIN users u ON u.id = c.user_id
           ORDER BY c.updated_at DESC"""
    )
    print(f"\nconversations ({len(convs)}):")
    for c in convs:
        print(f"  {c['title'][:34]:36} {c['msgs']:>3} msgs  {c['email']:28} {c['updated_at']:%Y-%m-%d %H:%M}")

    await conn.close()


asyncio.run(main())
