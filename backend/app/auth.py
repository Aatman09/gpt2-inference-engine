"""Phase 3 (see docs/ROADMAP.md): password hashing, JWT issuance/verification,
and the get_current_user dependency. Hand-rolled deliberately -- no managed
auth service -- single access-token cookie, no refresh-token rotation (see
ROADMAP.md's Phase 3 section for the reasoning)."""
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from urllib.parse import urlencode
import jwt
from fastapi import Depends, HTTPException, Request, status
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.config import Config

from .database import User, get_db

# no .env in the deployed container -- fall back to real environment variables
# (see the same pattern in database.py)
_env_file = Path(__file__).resolve().parent / ".env"
config = Config(str(_env_file) if _env_file.is_file() else None)
JWT_SECRET = config("JWT_SECRET")
JWT_ALGORITHM = "HS256"
JWT_EXPIRES = timedelta(days=7)
COOKIE_NAME = "access_token"

GOOGLE_CLIENT_ID = config("GOOGLE_CLIENT_ID" , default="")
GOOGLE_CLIENT_SECRET = config("GOOGLE_CLIENT_SECRET" , default="")
GOOGLE_REDIRECT_URI = config("GOOGLE_REDIRECT_URI" , default="http://localhost:8010/auth/google/callback" )
GOOGLE_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

OAUTH_STATE_COOKIE = "oauth_state"

def google_authorize_url(state:str) ->str:
    params = {
        "client_id" : GOOGLE_CLIENT_ID,
        "redirect_uri" : GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope":"openid email profile", 
        "state" : state, 
        "prompt" : "select_account",
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"

def new_oauth_state() -> str : 
    return secrets.token_urlsafe(32)

async def exchange_google_code(code:str) -> dict:
    async with httpx.AsyncClient(timeout=10) as Client:
        token_response = await Client.post(
            GOOGLE_TOKEN_URL, 
            data = {
                "code" : code, 
                "client_id" : GOOGLE_CLIENT_ID, 
                "client_secret" : GOOGLE_CLIENT_SECRET, 
                # spelled "redirect_uri" -- Google treats any other spelling as
                # the parameter being absent and rejects the exchange
                "redirect_uri" : GOOGLE_REDIRECT_URI,
                "grant_type":"authorization_code",
            },
        )
        if token_response.status_code != 200:
            raise HTTPException(status_code=400 , detail= "Google token exchange Failed")

        access_token = token_response.json().get("access_token")
        if not access_token:
            raise HTTPException(status_code = 400 , detail = "No Access Token recieved")

        userinfo_reponse = await Client.get(
            GOOGLE_USERINFO_URL, 
            headers={"Authorization" : f"Bearer {access_token}"},
        )
        if userinfo_reponse.status_code != 200 :
            raise HTTPException(status_code=400 , detail = "Couldn't fetch User profile")

    return userinfo_reponse.json()


async def find_or_create_google_user(db: AsyncSession, profile: dict) -> User:
    """Resolve a Google profile to a User row, creating or linking as needed."""
    google_id = profile.get("sub")
    email = profile.get("email")

    # an unverified email must never be trusted for the linking branch below:
    # anyone can put an arbitrary address on a Google account, so honouring it
    # would let an attacker take over a local-password account by signing up
    # with the victim's address
    if not google_id or not email or not profile.get("email_verified"):
        raise HTTPException(
            status_code=400, detail="Google account has no verified email"
        )

    # returning user, matched on the stable Google subject id rather than email
    # -- a user can change their Google email address, and matching on it would
    # orphan their account and history
    result = await db.execute(select(User).where(User.google_id == google_id))
    user = result.scalar_one_or_none()
    if user is not None:
        return user

    # existing local account with the same verified email: link the two rather
    # than erroring or creating a duplicate. Safe only because of the
    # email_verified check above.
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is not None:
        user.google_id = google_id
        await db.commit()
        await db.refresh(user)
        return user

    user = User(
        email=email,
        # Google omits "name" on some accounts; fall back to the local part
        name=profile.get("name") or email.split("@")[0],
        # stays null -- login() already refuses any user whose password is None,
        # so this account simply cannot be reached through the password route
        password=None,
        google_id=google_id,
        auth_provider="google",
    )
    db.add(user)
    await db.commit()
    # created_at is server-computed; refresh before the route serializes the
    # row through response_model, or it lazy-loads outside the greenlet
    # (the same MissingGreenlet failure updated_at hit in Phase 1)
    await db.refresh(user)
    return user


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
