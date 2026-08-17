"""Phase 3 (see docs/ROADMAP.md): password hashing, JWT issuance/verification,
and the get_current_user dependency. Hand-rolled deliberately -- no managed
auth service -- single access-token cookie, no refresh-token rotation (see
ROADMAP.md's Phase 3 section for the reasoning)."""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import Depends, HTTPException, Request, status
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.config import Config

from .database import User, get_db

config = Config(str(Path(__file__).resolve().parent / ".env"))
JWT_SECRET = config("JWT_SECRET")
JWT_ALGORITHM = "HS256"
JWT_EXPIRES = timedelta(days=7)
COOKIE_NAME = "access_token"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(user_id) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + JWT_EXPIRES,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> str:
    """Returns the user id (sub claim). Raises jwt exceptions on invalid/expired."""
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    return payload["sub"]


async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    try:
        user_id = decode_access_token(token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    return user
