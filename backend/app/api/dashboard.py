from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import Principal, get_principal
from app.database import get_db
from app.models import Membership, WorkItem

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard/summary")
def dashboard_summary(
    principal: Principal = Depends(get_principal), db: Session = Depends(get_db)
) -> dict[str, int]:
    active = WorkItem.status.notin_(("RESOLVED", "CLOSED"))
    row = db.execute(
        select(
            func.count().filter(
                WorkItem.assignee_id == principal.user.id, active
            ).label("assigned"),
            func.count().filter(
                WorkItem.assignee_id.is_(None), WorkItem.priority == "URGENT", active
            ).label("urgent"),
            func.count().filter(
                WorkItem.status == "AWAITING_APPROVAL",
                Membership.role.in_(("LEAD", "ADMIN")),
            ).label("approval"),
            func.count().filter(
                WorkItem.due_at < func.now(), active
            ).label("overdue"),
        )
        .select_from(WorkItem)
        .join(Membership, Membership.team_id == WorkItem.team_id)
        .where(Membership.user_id == principal.user.id)
    ).one()
    return {
        "assignedToMe": int(row.assigned),
        "unassignedUrgent": int(row.urgent),
        "awaitingMyApproval": int(row.approval),
        "overdue": int(row.overdue),
    }
