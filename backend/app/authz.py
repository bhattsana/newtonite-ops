from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain import Role, at_least
from app.errors import ApiError
from app.models import Membership, WorkItem


def require_team_role(db: Session, user_id: int, team_id: int, minimum: Role = "VIEWER") -> Membership:
    membership = db.scalar(
        select(Membership).where(Membership.user_id == user_id, Membership.team_id == team_id)
    )
    if membership is None:
        raise ApiError(403, "FORBIDDEN", "Not a member of that team")
    if not at_least(membership.role, minimum):
        raise ApiError(403, "FORBIDDEN", f"Requires {minimum} role")
    return membership


def require_item_role(
    db: Session, user_id: int, item_id: int, minimum: Role = "VIEWER"
) -> tuple[WorkItem, Membership]:
    row = db.execute(
        select(WorkItem, Membership)
        .join(Membership, Membership.team_id == WorkItem.team_id)
        .where(WorkItem.id == item_id, Membership.user_id == user_id)
    ).first()
    if row is None:
        raise ApiError(404, "NOT_FOUND", "Work item not found")
    item, membership = row
    if not at_least(membership.role, minimum):
        raise ApiError(403, "FORBIDDEN", f"Requires {minimum} role")
    return item, membership
