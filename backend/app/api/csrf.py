from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import ApiError
from app.security import validate_csrf


def require_csrf(request: Request, db: Session = Depends(get_db)) -> None:
    if not validate_csrf(request, db):
        raise ApiError(403, "CSRF_FAILED", "Request verification failed. Refresh the page and try again.")
