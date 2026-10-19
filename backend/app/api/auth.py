import secrets
from datetime import UTC, datetime

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, func, literal_column, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.api.csrf import require_csrf
from app.api.deps import Principal, get_principal
from app.config import get_settings
from app.database import get_db
from app.errors import ApiError
from app.models import LoginAttempt, Membership, User, UserSession
from app.schemas import LoginRequest
from app.security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    create_session,
    new_token,
    set_csrf_cookie,
    set_session_cookie,
    token_hash,
)

router = APIRouter(prefix="/auth", tags=["auth"])
password_hasher = PasswordHasher()
DUMMY_HASH = password_hasher.hash("timing-equalizer")


@router.get("/csrf")
def csrf_token(request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    token = request.cookies.get(CSRF_COOKIE)
    session_token = request.cookies.get(SESSION_COOKIE)
    active_session = None
    if session_token:
        active_session = db.scalar(
            select(UserSession).where(
                UserSession.token_hash == token_hash(session_token),
                UserSession.expires_at > datetime.now(UTC),
            )
        )
    if not token or (
        active_session
        and not secrets.compare_digest(active_session.csrf_hash, token_hash(token))
    ):
        token = new_token()
        if active_session:
            active_session.csrf_hash = token_hash(token)
            db.commit()
    set_csrf_cookie(response, token)
    response.headers["Cache-Control"] = "no-store"
    return {"csrfToken": token}


@router.post("/login", dependencies=[Depends(require_csrf)])
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    settings = get_settings()
    email = payload.email.strip().lower()
    client_ip = request.client.host if request.client else "unknown"
    throttle_key = f"{email}|{client_ip}"
    window = literal_column("interval '15 minutes'")
    attempt = db.scalar(
        select(LoginAttempt).where(
            LoginAttempt.key == throttle_key,
            LoginAttempt.window_start > func.now() - window,
        )
    )
    if attempt and attempt.failures >= settings.login_max_failures:
        retry = db.scalar(
            select(
                func.greatest(
                    1,
                    func.ceil(
                        func.extract(
                            "epoch",
                            attempt.window_start + window - func.now(),
                        )
                    ),
                )
            )
        )
        raise ApiError(
            429,
            "TOO_MANY_ATTEMPTS",
            "Too many failed sign-in attempts. Try again later.",
            headers={"Retry-After": str(int(retry or 1))},
        )
    user = db.scalar(select(User).where(User.email == email))
    stored_hash = user.password_hash if user else DUMMY_HASH
    try:
        password_valid = password_hasher.verify(stored_hash, payload.password)
    except (VerifyMismatchError, VerificationError):
        password_valid = False
    if not user or not password_valid:
        db.execute(
            insert(LoginAttempt)
            .values(key=throttle_key, failures=1, window_start=func.now())
            .on_conflict_do_update(
                index_elements=[LoginAttempt.key],
                set_={
                    "failures": text(
                        "CASE WHEN login_attempts.window_start < now() - interval '15 minutes' "
                        "THEN 1 ELSE login_attempts.failures + 1 END"
                    ),
                    "window_start": text(
                        "CASE WHEN login_attempts.window_start < now() - interval '15 minutes' "
                        "THEN now() ELSE login_attempts.window_start END"
                    ),
                },
            )
        )
        db.commit()
        raise ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password")

    db.execute(delete(LoginAttempt).where(LoginAttempt.key == throttle_key))
    previous_session_token = request.cookies.get(SESSION_COOKIE)
    if previous_session_token:
        previous_session = db.scalar(
            select(UserSession).where(UserSession.token_hash == token_hash(previous_session_token))
        )
        if previous_session:
            db.delete(previous_session)
    csrf = request.cookies.get(CSRF_COOKIE)
    if not csrf:
        csrf = new_token()
        set_csrf_cookie(response, csrf)
    raw_session, expires_at = create_session(db, user.id, csrf)
    db.commit()
    set_session_cookie(response, raw_session)
    response.headers["Cache-Control"] = "no-store"
    return {
        "user": {"id": user.id, "name": user.name, "email": user.email},
        "expiresAt": expires_at.isoformat(),
    }


@router.get("/me")
def me(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)) -> dict:
    memberships = db.scalars(
        select(Membership).where(Membership.user_id == principal.user.id)
    ).all()
    return {
        "user": {"id": principal.user.id, "name": principal.user.name},
        "memberships": [
            {"team_id": membership.team_id, "role": membership.role} for membership in memberships
        ],
    }


@router.post("/logout", status_code=204, dependencies=[Depends(require_csrf)])
def logout(
    response: Response,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> None:
    db.delete(principal.session)
    db.commit()
    settings = get_settings()
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="none" if settings.app_env.lower() == "production" else "lax",
    )
    response.delete_cookie(
        CSRF_COOKIE,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="none" if settings.app_env.lower() == "production" else "lax",
    )
    response.status_code = 204
