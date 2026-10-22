from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import Date, Text, and_, case, cast, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import Principal, get_principal
from app.database import get_db
from app.models import ActivityEvent, Membership, Team, User, WorkItem
from app.schemas import DashboardSummaryOut, Status

router = APIRouter(tags=["dashboard"])
STATUSES: tuple[Status, ...] = (
    "OPEN",
    "IN_PROGRESS",
    "AWAITING_APPROVAL",
    "RESOLVED",
    "CLOSED",
)
ACTIVE_STATUSES: tuple[Status, ...] = ("OPEN", "IN_PROGRESS", "AWAITING_APPROVAL")
PRIORITY_POINTS = {"LOW": 10, "MEDIUM": 25, "HIGH": 45, "URGENT": 60}
MAX_PRIORITY_SCORE = 110
DEADLINE_WATCH_DAYS = 7
STATUS_STALE_DAYS = 7
APPROVAL_STALE_DAYS = 3
TREND_DAYS = 14


def priority_assessment(
    *,
    priority: str,
    status: str,
    due_at: datetime | None,
    status_since: datetime,
    now: datetime,
    assignee_id: int | None,
) -> tuple[int, list[str], int]:
    factors = [f"{priority.title()} priority (+{PRIORITY_POINTS[priority]} points)"]
    points = PRIORITY_POINTS[priority]
    remaining = (due_at - now).total_seconds() if due_at else None
    if remaining is not None and remaining < 0:
        points += 25
        factors.append("Past its recorded due date (+25)")
    elif remaining is not None and remaining <= 24 * 60 * 60:
        points += 15
        factors.append("Due within 24 hours (+15)")
    elif remaining is not None and remaining <= 3 * 24 * 60 * 60:
        points += 8
        factors.append("Due within 3 days (+8)")
    if status == "AWAITING_APPROVAL":
        points += 10
        factors.append("Awaiting approval (+10)")
    if assignee_id is None:
        points += 5
        factors.append("Unassigned (+5)")
    status_age_days = max(0, (now - status_since).days)
    if status_age_days >= STATUS_STALE_DAYS:
        points += 10
        factors.append(f"No status transition for {status_age_days} days (+10)")
    elif status_age_days >= 3:
        points += 5
        factors.append(f"No status transition for {status_age_days} days (+5)")
    score = min(100, round(points * 100 / MAX_PRIORITY_SCORE))
    return score, factors, status_age_days


def deadline_risk(*, due_at: datetime, now: datetime) -> str:
    if due_at < now:
        return "OVERDUE"
    if due_at <= now + timedelta(hours=24):
        return "AT_RISK"
    return "UPCOMING"


def _visible_team_ids(user_id: int):
    return select(Membership.team_id).where(Membership.user_id == user_id)


def _status_since_expression():
    last_transition = (
        select(func.max(ActivityEvent.created_at))
        .where(
            ActivityEvent.work_item_id == WorkItem.id,
            ActivityEvent.event_type.in_(("STATUS_CHANGED", "APPROVED", "APPROVAL_REJECTED")),
        )
        .correlate(WorkItem)
        .scalar_subquery()
    )
    return func.coalesce(last_transition, WorkItem.created_at)


@router.get("/dashboard/summary", response_model=DashboardSummaryOut)
def dashboard_summary(
    principal: Principal = Depends(get_principal), db: Session = Depends(get_db)
) -> dict[str, object]:
    user_id = principal.user.id
    now = datetime.now(UTC)
    visible_team_ids = _visible_team_ids(user_id)
    active = WorkItem.status.in_(ACTIVE_STATUSES)
    rows = db.execute(
        select(
            WorkItem.status,
            func.count(func.distinct(WorkItem.id)).label("total"),
            func.count(func.distinct(WorkItem.id)).filter(active).label("active"),
            func.count(func.distinct(WorkItem.id)).filter(
                active, WorkItem.priority.in_(("HIGH", "URGENT"))
            ).label("critical_high"),
            func.count(func.distinct(WorkItem.id)).filter(
                active, WorkItem.assignee_id == user_id
            ).label("assigned"),
            func.count(func.distinct(WorkItem.id)).filter(
                active,
                WorkItem.assignee_id.is_(None),
                WorkItem.priority.in_(("HIGH", "URGENT")),
            ).label("unassigned_urgent"),
            func.count(func.distinct(WorkItem.id)).filter(
                WorkItem.status == "AWAITING_APPROVAL",
                Membership.role.in_(("LEAD", "ADMIN")),
            ).label("awaiting_approval"),
            func.count(func.distinct(WorkItem.id)).filter(
                WorkItem.due_at < now, active
            ).label("overdue"),
        )
        .select_from(WorkItem)
        .join(Membership, Membership.team_id == WorkItem.team_id)
        .where(Membership.user_id == user_id)
        .group_by(WorkItem.status)
    ).all()

    status_counts = dict.fromkeys(STATUSES, 0)
    totals = {
        "active": 0,
        "critical_high": 0,
        "assigned": 0,
        "unassigned_urgent": 0,
        "awaiting_approval": 0,
        "overdue": 0,
    }
    for row in rows:
        status_counts[row.status] = int(row.total)
        for key, column in (
            ("active", row.active),
            ("critical_high", row.critical_high),
            ("assigned", row.assigned),
            ("unassigned_urgent", row.unassigned_urgent),
            ("awaiting_approval", row.awaiting_approval),
            ("overdue", row.overdue),
        ):
            totals[key] += int(column)

    status_since = _status_since_expression()
    priority_points = case(
        (WorkItem.priority == "URGENT", PRIORITY_POINTS["URGENT"]),
        (WorkItem.priority == "HIGH", PRIORITY_POINTS["HIGH"]),
        (WorkItem.priority == "MEDIUM", PRIORITY_POINTS["MEDIUM"]),
        else_=PRIORITY_POINTS["LOW"],
    )
    due_points = case(
        (and_(WorkItem.due_at.is_not(None), WorkItem.due_at < now), 25),
        (WorkItem.due_at <= now + timedelta(hours=24), 15),
        (WorkItem.due_at <= now + timedelta(days=3), 8),
        else_=0,
    )
    age_seconds = func.extract("epoch", now - status_since)
    age_points = case(
        (age_seconds >= STATUS_STALE_DAYS * 86400, 10),
        (age_seconds >= 3 * 86400, 5),
        else_=0,
    )
    score_points = (
        priority_points
        + due_points
        + case((WorkItem.status == "AWAITING_APPROVAL", 10), else_=0)
        + case((WorkItem.assignee_id.is_(None), 5), else_=0)
        + age_points
    )
    intelligence_rows = db.execute(
        select(
            WorkItem,
            Team.name.label("team_name"),
            User.name.label("assignee_name"),
            status_since.label("status_since"),
            score_points.label("score_points"),
        )
        .join(Team, Team.id == WorkItem.team_id)
        .outerjoin(User, User.id == WorkItem.assignee_id)
        .where(WorkItem.team_id.in_(visible_team_ids), active)
        .order_by(score_points.desc(), WorkItem.due_at.asc().nulls_last(), WorkItem.id.desc())
        .limit(8)
    ).all()
    intelligence = []
    for item, team_name, assignee_name, since, _points in intelligence_rows:
        score, factors, age = priority_assessment(
            priority=item.priority,
            status=item.status,
            due_at=item.due_at,
            status_since=since,
            now=now,
            assignee_id=item.assignee_id,
        )
        intelligence.append({
            "id": item.id,
            "reference": item.reference,
            "title": item.title,
            "status": item.status,
            "priority": item.priority,
            "teamId": item.team_id,
            "teamName": team_name,
            "assigneeName": assignee_name,
            "dueAt": item.due_at,
            "score": score,
            "factors": factors,
            "statusAgeDays": age,
        })

    deadline_rows = db.execute(
        select(
            WorkItem,
            Team.name.label("team_name"),
            User.name.label("assignee_name"),
        )
        .join(Team, Team.id == WorkItem.team_id)
        .outerjoin(User, User.id == WorkItem.assignee_id)
        .where(
            WorkItem.team_id.in_(visible_team_ids),
            active,
            WorkItem.due_at.is_not(None),
            WorkItem.due_at <= now + timedelta(days=DEADLINE_WATCH_DAYS),
        )
        .order_by(WorkItem.due_at.asc(), WorkItem.id.desc())
        .limit(10)
    ).all()
    deadline_watch = []
    for item, team_name, assignee_name in deadline_rows:
        risk = deadline_risk(due_at=item.due_at, now=now)
        deadline_watch.append({
            "id": item.id,
            "reference": item.reference,
            "title": item.title,
            "status": item.status,
            "priority": item.priority,
            "dueAt": item.due_at,
            "teamId": item.team_id,
            "teamName": team_name,
            "assigneeName": assignee_name,
            "risk": risk,
        })

    stale_by_status = db.execute(
        select(WorkItem.status, func.count(func.distinct(WorkItem.id)))
        .where(
            WorkItem.team_id.in_(visible_team_ids),
            active,
            status_since <= now - timedelta(days=STATUS_STALE_DAYS),
        )
        .group_by(WorkItem.status)
    ).all()
    approvals_older = db.scalar(
        select(func.count(func.distinct(WorkItem.id)))
        .select_from(WorkItem)
        .join(Membership, Membership.team_id == WorkItem.team_id)
        .where(
            Membership.user_id == user_id,
            Membership.role.in_(("LEAD", "ADMIN")),
            WorkItem.status == "AWAITING_APPROVAL",
            status_since <= now - timedelta(days=APPROVAL_STALE_DAYS),
        )
    ) or 0
    bottlenecks = []
    for status, count in stale_by_status:
        if count >= 3:
            bottlenecks.append({
                "key": f"stale-{status.lower()}",
                "title": f"Long-running {status.replace('_', ' ').lower()} work",
                "count": int(count),
                "evidence": f"{count} active items have had no recorded status transition for at least {STATUS_STALE_DAYS} days.",
                "recommendation": "Review the queue and record the next workflow step where appropriate.",
                "status": status,
            })
    if approvals_older:
        bottlenecks.append({
            "key": "aging-approvals",
            "title": "Aging approval queue",
            "count": int(approvals_older),
            "evidence": f"{approvals_older} accessible approval requests have had no recorded status transition for at least {APPROVAL_STALE_DAYS} days.",
            "recommendation": "Review pending approvals with your team leads.",
            "status": "AWAITING_APPROVAL",
        })

    team_rows = db.execute(
        select(
            Team.id,
            Team.name,
            func.count(func.distinct(WorkItem.id)).filter(active).label("active"),
            func.count(func.distinct(WorkItem.id)).filter(
                active, WorkItem.priority.in_(("HIGH", "URGENT"))
            ).label("high_priority"),
            func.count(func.distinct(WorkItem.id)).filter(
                active, WorkItem.assignee_id.is_(None)
            ).label("unassigned"),
            func.count(func.distinct(WorkItem.id)).filter(
                active, WorkItem.due_at < now
            ).label("overdue"),
            func.count(func.distinct(WorkItem.id)).filter(
                WorkItem.status == "AWAITING_APPROVAL"
            ).label("awaiting_approval"),
        )
        .select_from(Team)
        .join(Membership, Membership.team_id == Team.id)
        .outerjoin(WorkItem, WorkItem.team_id == Team.id)
        .where(Membership.user_id == user_id)
        .group_by(Team.id, Team.name)
        .order_by(Team.name)
    ).all()
    team_workload = [
        {
            "teamId": row.id,
            "teamName": row.name,
            "active": int(row.active),
            "highPriority": int(row.high_priority),
            "unassigned": int(row.unassigned),
            "overdue": int(row.overdue),
            "awaitingApproval": int(row.awaiting_approval),
        }
        for row in team_rows
    ]

    assignee_rows = db.execute(
        select(
            User.id,
            User.name,
            func.count(func.distinct(WorkItem.id)).label("active"),
            func.count(func.distinct(WorkItem.id)).filter(
                WorkItem.priority.in_(("HIGH", "URGENT"))
            ).label("high_priority"),
        )
        .select_from(WorkItem)
        .join(Membership, Membership.team_id == WorkItem.team_id)
        .join(User, User.id == WorkItem.assignee_id)
        .where(Membership.user_id == user_id, active)
        .group_by(User.id, User.name)
        .order_by(func.count(func.distinct(WorkItem.id)).desc(), User.name)
        .limit(12)
    ).all()
    assignee_workload = [
        {
            "assigneeId": row.id,
            "assigneeName": row.name,
            "active": int(row.active),
            "highPriority": int(row.high_priority),
        }
        for row in assignee_rows
    ]

    today = now.date()
    trend_start = today - timedelta(days=TREND_DAYS - 1)
    event_rows = db.execute(
        select(
            cast(ActivityEvent.created_at, Date).label("event_date"),
            func.count(func.distinct(ActivityEvent.id)).filter(
                ActivityEvent.event_type == "CREATED"
            ).label("created"),
            func.count(func.distinct(ActivityEvent.id)).filter(
                or_(
                    ActivityEvent.event_type == "APPROVED",
                    and_(
                        ActivityEvent.event_type == "STATUS_CHANGED",
                        cast(ActivityEvent.new_value, Text) == '"RESOLVED"',
                    ),
                )
            ).label("completed"),
        )
        .select_from(ActivityEvent)
        .join(WorkItem, WorkItem.id == ActivityEvent.work_item_id)
        .where(
            WorkItem.team_id.in_(visible_team_ids),
            ActivityEvent.created_at >= datetime.combine(trend_start, datetime.min.time(), UTC),
        )
        .group_by(cast(ActivityEvent.created_at, Date))
    ).all()
    trends_by_date = {
        row.event_date: (int(row.created), int(row.completed))
        for row in event_rows
    }
    trends = []
    for offset in range(TREND_DAYS):
        day = trend_start + timedelta(days=offset)
        created, completed = trends_by_date.get(day, (0, 0))
        trends.append({"date": day.isoformat(), "created": created, "completed": completed})

    latest_activity_query = (
        select(func.max(ActivityEvent.created_at))
        .join(WorkItem, WorkItem.id == ActivityEvent.work_item_id)
        .where(WorkItem.team_id.in_(visible_team_ids))
    )
    latest_item_update_query = select(func.max(WorkItem.updated_at)).where(
        WorkItem.team_id.in_(visible_team_ids)
    )
    latest_activity, latest_item_update = db.execute(
        select(latest_activity_query.scalar_subquery(), latest_item_update_query.scalar_subquery())
    ).one()
    updates = [timestamp for timestamp in (latest_activity, latest_item_update) if timestamp]

    return {
        "criticalHigh": totals["critical_high"],
        "assignedToMe": totals["assigned"],
        "unassignedUrgent": totals["unassigned_urgent"],
        "awaitingMyApproval": totals["awaiting_approval"],
        "overdue": totals["overdue"],
        "activeTotal": totals["active"],
        "statusCounts": status_counts,
        "lastUpdatedAt": max(updates) if updates else None,
        "intelligence": intelligence,
        "deadlineWatch": deadline_watch,
        "bottlenecks": bottlenecks,
        "teamWorkload": team_workload,
        "assigneeWorkload": assignee_workload,
        "trends": trends,
    }
