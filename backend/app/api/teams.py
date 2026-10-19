from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import Principal, get_principal
from app.database import get_db
from app.errors import ApiError
from app.models import Membership, Team, User

router = APIRouter(tags=["teams"])


@router.get("/teams")
def list_teams(
    principal: Principal = Depends(get_principal), db: Session = Depends(get_db)
) -> dict:
    rows = db.execute(
        select(Team, Membership.role)
        .join(Membership, Membership.team_id == Team.id)
        .where(Membership.user_id == principal.user.id)
        .order_by(Team.name)
    ).all()
    return {
        "data": [
            {
                "id": team.id,
                "name": team.name,
                "slug": team.slug,
                "description": team.description,
                "role": role,
            }
            for team, role in rows
        ]
    }


@router.get("/teams/{team_id}/members")
def list_team_members(
    team_id: int,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    membership = db.scalar(
        select(Membership).where(
            Membership.team_id == team_id, Membership.user_id == principal.user.id
        )
    )
    if membership is None:
        raise ApiError(404, "NOT_FOUND", "Team not found")
    rows = db.execute(
        select(User.id, User.name, User.email, Membership.role)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.team_id == team_id)
        .order_by(User.name)
    ).all()
    return {
        "data": [
            {"id": user_id, "name": name, "email": email, "role": role}
            for user_id, name, email, role in rows
        ]
    }
