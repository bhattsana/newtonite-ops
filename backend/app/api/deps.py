from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import ApiError
from app.models import User, UserSession
from app.security import token_hash


@dataclass(frozen=True)
class Principal:
    user: User
    session: UserSession


def get_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    raw_token = request.cookies.get("newtonite_session")
    if not raw_token:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication required")
    row = db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.token_hash == token_hash(raw_token),
            UserSession.expires_at > datetime.now(UTC),
        )
    ).first()
    if row is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication required")
    return Principal(user=row[1], session=row[0])
