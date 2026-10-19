import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import UserSession

SESSION_COOKIE = "newtonite_session"
CSRF_COOKIE = "newtonite_csrf"


def token_hash(value: str) -> str:
    secret = get_settings().session_secret
    return hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def csrf_matches(request: Request) -> bool:
    cookie = request.cookies.get(CSRF_COOKIE, "")
    header = request.headers.get("x-csrf-token", "")
    return bool(cookie and header and hmac.compare_digest(cookie, header))


def validate_csrf(request: Request, db: Session) -> bool:
    if not csrf_matches(request):
        return False
    session_token = request.cookies.get(SESSION_COOKIE)
    if not session_token:
        return request.url.path == "/api/v1/auth/login"
    session = db.scalar(
        select(UserSession).where(UserSession.token_hash == token_hash(session_token))
    )
    if session is None:
        return request.url.path == "/api/v1/auth/login"
    csrf_cookie = request.cookies.get(CSRF_COOKIE, "")
    return hmac.compare_digest(session.csrf_hash, token_hash(csrf_cookie))


def set_csrf_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        CSRF_COOKIE,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="none" if settings.app_env.lower() == "production" else "lax",
        path="/",
        max_age=settings.session_ttl_minutes * 60,
    )


def set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="none" if settings.app_env.lower() == "production" else "lax",
        path="/",
        max_age=settings.session_ttl_minutes * 60,
    )


def create_session(db: Session, user_id: int, csrf_token: str) -> tuple[str, datetime]:
    settings = get_settings()
    raw_token = new_token()
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.session_ttl_minutes)
    db.add(
        UserSession(
            token_hash=token_hash(raw_token),
            csrf_hash=token_hash(csrf_token),
            user_id=user_id,
            expires_at=expires_at,
        )
    )
    return raw_token, expires_at
