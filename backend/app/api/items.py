import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.api.csrf import require_csrf
from app.api.deps import Principal, get_principal
from app.authz import require_item_role, require_team_role
from app.database import get_db
from app.domain import TRANSITIONS, at_least
from app.errors import ApiError
from app.models import (
    ActivityEvent,
    Comment,
    IdempotencyRecord,
    Membership,
    OutboxJob,
    User,
    WorkItem,
)
from app.schemas import (
    ActivityOut,
    CommentRequest,
    CreateItemRequest,
    ItemOut,
    PatchItemRequest,
    Status,
    TransitionRequest,
)

router = APIRouter(prefix="/items", tags=["items"])
STATUSES = ("OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED")
PRIORITIES = ("LOW", "MEDIUM", "HIGH", "URGENT")


def item_payload(item: WorkItem, assignee_name: str | None = None, *, include_assignee: bool = False) -> dict:
    data = ItemOut.model_validate(item).model_dump(mode="json", exclude={"assignee_name"})
    if include_assignee:
        data["assignee_name"] = assignee_name
    return data


def activity_row(event: ActivityEvent, actor_name: str) -> dict:
    return ActivityOut(
        id=event.id,
        event_type=event.event_type,
        actor_name=actor_name,
        previous_value=event.previous_value,
        new_value=event.new_value,
        metadata=event.metadata_,
        created_at=event.created_at,
    ).model_dump(mode="json")


def log_event(
    db: Session,
    item_id: int,
    actor_id: int,
    event_type: str,
    previous: Any = None,
    new: Any = None,
    metadata: Any = None,
) -> None:
    db.add(
        ActivityEvent(
            work_item_id=item_id,
            actor_id=actor_id,
            event_type=event_type,
            previous_value=previous,
            new_value=new,
            metadata_=metadata,
        )
    )


def add_outbox(db: Session, event_type: str, payload: dict[str, Any]) -> None:
    db.add(OutboxJob(event_type=event_type, payload=payload))


def stale_error() -> ApiError:
    return ApiError(409, "STALE_VERSION", "This item was changed by someone else. Reload and retry.")


@router.get("")
def list_items(
    status: Status | None = None,
    team_id: int | None = Query(default=None, alias="teamId"),
    assignee_id: int | None = Query(default=None, alias="assigneeId"),
    q: str | None = Query(default=None, max_length=100),
    overdue: bool = False,
    priority: str | None = None,
    type: str | None = Query(default=None, max_length=40),
    unassigned: bool = False,
    active: bool = False,
    approvable: bool = False,
    limit: int = Query(default=25, ge=1, le=100),
    cursor: int | None = None,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    if priority is not None and priority not in PRIORITIES:
        raise ApiError(422, "VALIDATION_ERROR", "Invalid request", {"priority": ["Invalid priority"]})
    stmt = (
        select(WorkItem, User.name.label("assignee_name"))
        .join(Membership, and_(
            Membership.team_id == WorkItem.team_id, Membership.user_id == principal.user.id
        ))
        .outerjoin(User, User.id == WorkItem.assignee_id)
    )
    if status:
        stmt = stmt.where(WorkItem.status == status)
    if team_id is not None:
        stmt = stmt.where(WorkItem.team_id == team_id)
    if assignee_id is not None:
        stmt = stmt.where(WorkItem.assignee_id == assignee_id)
    if cursor:
        stmt = stmt.where(WorkItem.id < cursor)
    if priority:
        stmt = stmt.where(WorkItem.priority == priority)
    if type:
        stmt = stmt.where(WorkItem.type == type)
    if unassigned:
        stmt = stmt.where(WorkItem.assignee_id.is_(None))
    if active:
        stmt = stmt.where(WorkItem.status.notin_(("RESOLVED", "CLOSED")))
    if approvable:
        stmt = stmt.where(
            WorkItem.status == "AWAITING_APPROVAL", Membership.role.in_(("LEAD", "ADMIN"))
        )
    if overdue:
        stmt = stmt.where(
            WorkItem.due_at < func.now(), WorkItem.status.notin_(("RESOLVED", "CLOSED"))
        )
    if q:
        search = re.sub(r"[%_\\]", "", q)
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                WorkItem.title.ilike(pattern),
                WorkItem.description.ilike(pattern),
                WorkItem.reference.ilike(pattern),
            )
        )
    rows = db.execute(stmt.order_by(WorkItem.id.desc()).limit(limit + 1)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    data = [item_payload(item, assignee_name, include_assignee=True) for item, assignee_name in rows]
    return {"data": data, "nextCursor": data[-1]["id"] if has_more and data else None}


@router.post("", status_code=201, dependencies=[Depends(require_csrf)])
def create_item(
    payload: CreateItemRequest,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    require_team_role(db, principal.user.id, payload.team_id, "MEMBER")
    key = idempotency_key.strip() if idempotency_key else None
    if key and (not key or len(key) > 200):
        raise ApiError(422, "VALIDATION_ERROR", "Invalid request", {"Idempotency-Key": ["Invalid key"]})
    canonical = json.dumps(payload.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    request_hash = hashlib.sha256(canonical.encode()).hexdigest()
    try:
        if key:
            db.execute(
                delete(IdempotencyRecord).where(
                    IdempotencyRecord.key == key,
                    IdempotencyRecord.actor_id == principal.user.id,
                    IdempotencyRecord.scope == "create_item",
                    IdempotencyRecord.expires_at < func.now(),
                )
            )
            inserted = db.execute(
                insert(IdempotencyRecord)
                .values(
                    key=key,
                    actor_id=principal.user.id,
                    scope="create_item",
                    request_hash=request_hash,
                )
                .on_conflict_do_nothing()
                .returning(IdempotencyRecord.id)
            ).scalar_one_or_none()
            if inserted is None:
                record = db.scalar(
                    select(IdempotencyRecord).where(
                        IdempotencyRecord.key == key,
                        IdempotencyRecord.actor_id == principal.user.id,
                        IdempotencyRecord.scope == "create_item",
                    )
                )
                if record is None or record.request_hash != request_hash:
                    raise ApiError(
                        409,
                        "IDEMPOTENCY_KEY_REUSED",
                        "Idempotency-Key was used with a different payload",
                    )
                response.headers["Idempotent-Replay"] = "true"
                replay = record.response_body
                db.commit()
                return replay

        item = WorkItem(
            title=payload.title,
            description=payload.description,
            priority=payload.priority,
            type=payload.type,
            team_id=payload.team_id,
            created_by_id=principal.user.id,
            due_at=payload.due_at,
        )
        db.add(item)
        db.flush()
        log_event(
            db, item.id, principal.user.id, "CREATED", None,
            {"title": payload.title, "priority": payload.priority},
        )
        add_outbox(db, "ITEM_CREATED", {"itemId": item.id, "reference": item.reference})
        body = item_payload(item)
        if key:
            record = db.scalar(
                select(IdempotencyRecord).where(
                    IdempotencyRecord.key == key,
                    IdempotencyRecord.actor_id == principal.user.id,
                    IdempotencyRecord.scope == "create_item",
                )
            )
            assert record is not None
            record.response_status = 201
            record.response_body = body
        db.commit()
        return body
    except Exception:
        db.rollback()
        raise


@router.get("/{item_id}")
def get_item(
    item_id: int,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    item, _ = require_item_role(db, principal.user.id, item_id)
    return item_payload(item)


@router.patch("/{item_id}", dependencies=[Depends(require_csrf)])
def patch_item(
    item_id: int,
    payload: PatchItemRequest,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    item, membership = require_item_role(db, principal.user.id, item_id, "MEMBER")
    if item.version != payload.expected_version:
        raise stale_error()
    changes: dict[str, Any] = {}
    for field, column in (
        ("title", "title"),
        ("description", "description"),
        ("priority", "priority"),
        ("due_at", "due_at"),
        ("assignee_id", "assignee_id"),
    ):
        if field not in payload.model_fields_set:
            continue
        value = getattr(payload, field)
        if field in ("title", "description", "priority") and value is None:
            raise ApiError(422, "VALIDATION_ERROR", "Invalid request", {field: ["Field cannot be null"]})
        current = getattr(item, column)
        if isinstance(current, datetime):
            current = current.isoformat()
        if isinstance(value, datetime):
            value = value.isoformat()
        if current != value:
            changes[column] = getattr(payload, field)
    if "assignee_id" in changes and changes["assignee_id"] != item.assignee_id:
        if not at_least(membership.role, "LEAD"):
            raise ApiError(403, "FORBIDDEN", "Only a Lead can reassign")
        assignee_id = changes["assignee_id"]
        if assignee_id is not None:
            assignee = db.scalar(
                select(Membership).where(
                    Membership.user_id == assignee_id, Membership.team_id == item.team_id
                )
            )
            if assignee is None or not at_least(assignee.role, "MEMBER"):
                raise ApiError(
                    422, "INVALID_ASSIGNEE", "Assignee must be a member of the item team"
                )
    if not changes:
        return item_payload(item)
    previous = {
        name: getattr(item, name).isoformat() if isinstance(getattr(item, name), datetime) else getattr(item, name)
        for name in changes
    }
    result = db.execute(
        update(WorkItem)
        .where(WorkItem.id == item_id, WorkItem.version == payload.expected_version)
        .values(**changes, version=WorkItem.version + 1, updated_at=func.now())
        .returning(WorkItem)
    ).scalar_one_or_none()
    if result is None:
        db.rollback()
        raise stale_error()
    for name, value in changes.items():
        if isinstance(value, datetime):
            value = value.isoformat()
        log_event(
            db,
            item_id,
            principal.user.id,
            f"{name.upper()}_CHANGED",
            previous[name],
            value,
        )
    db.commit()
    return item_payload(result)


@router.post("/{item_id}/claim", dependencies=[Depends(require_csrf)])
def claim_item(
    item_id: int,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    item, _ = require_item_role(db, principal.user.id, item_id, "MEMBER")
    new_status = "IN_PROGRESS" if item.status == "OPEN" else item.status
    claimed = db.execute(
        update(WorkItem)
        .where(
            WorkItem.id == item_id,
            WorkItem.assignee_id.is_(None),
            WorkItem.status.in_(("OPEN", "IN_PROGRESS")),
        )
        .values(
            assignee_id=principal.user.id,
            status=new_status,
            version=WorkItem.version + 1,
            updated_at=func.now(),
        )
        .returning(WorkItem)
    ).scalar_one_or_none()
    if claimed is None:
        db.rollback()
        raise ApiError(409, "ALREADY_CLAIMED", "This item has already been claimed or cannot be claimed")
    log_event(
        db,
        item_id,
        principal.user.id,
        "CLAIMED",
        {"assigneeId": None},
        {"assigneeId": principal.user.id},
    )
    db.commit()
    return item_payload(claimed)


@router.post("/{item_id}/transition", dependencies=[Depends(require_csrf)])
def transition_item(
    item_id: int,
    payload: TransitionRequest,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    item, membership = require_item_role(db, principal.user.id, item_id, "MEMBER")
    minimum = TRANSITIONS.get(item.status, {}).get(payload.to)
    if minimum is None:
        raise ApiError(409, "INVALID_TRANSITION", f"Cannot move from {item.status} to {payload.to}")
    if not at_least(membership.role, minimum):
        raise ApiError(403, "FORBIDDEN", f"Transition to {payload.to} requires {minimum} role")
    if item.version != payload.expected_version:
        raise stale_error()
    previous_status = item.status
    now = datetime.now(UTC)
    values: dict[str, Any] = {"status": payload.to, "version": WorkItem.version + 1, "updated_at": func.now()}
    if payload.to == "RESOLVED":
        values["resolved_at"] = now
    updated = db.execute(
        update(WorkItem)
        .where(WorkItem.id == item_id, WorkItem.version == payload.expected_version)
        .values(**values)
        .returning(WorkItem)
    ).scalar_one_or_none()
    if updated is None:
        db.rollback()
        raise stale_error()
    is_approval = previous_status == "AWAITING_APPROVAL"
    event_type = (
        "APPROVED" if payload.to == "RESOLVED" else "APPROVAL_REJECTED"
    ) if is_approval else "STATUS_CHANGED"
    log_event(
        db, item_id, principal.user.id, event_type, previous_status, payload.to,
        {"note": payload.note} if payload.note else None,
    )
    if payload.to in ("AWAITING_APPROVAL", "RESOLVED"):
        add_outbox(db, f"ITEM_{payload.to}", {"itemId": item.id, "reference": item.reference})
    db.commit()
    return item_payload(updated)


@router.get("/{item_id}/activity")
def list_activity(
    item_id: int,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    require_item_role(db, principal.user.id, item_id)
    rows = db.execute(
        select(ActivityEvent, User.name)
        .join(User, User.id == ActivityEvent.actor_id)
        .where(ActivityEvent.work_item_id == item_id)
        .order_by(ActivityEvent.id)
        .limit(200)
    ).all()
    return {"data": [activity_row(event, name) for event, name in rows]}


@router.get("/{item_id}/comments")
def list_comments(
    item_id: int,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    require_item_role(db, principal.user.id, item_id)
    comments = db.scalars(
        select(Comment).where(Comment.work_item_id == item_id).order_by(Comment.id).limit(200)
    ).all()
    return {
        "data": [
            {
                "id": comment.id,
                "author_id": comment.author_id,
                "body": comment.body,
                "created_at": comment.created_at.isoformat(),
                "updated_at": comment.updated_at.isoformat(),
            }
            for comment in comments
        ]
    }


@router.post("/{item_id}/comments", status_code=201, dependencies=[Depends(require_csrf)])
def create_comment(
    item_id: int,
    payload: CommentRequest,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
) -> dict:
    item, _ = require_item_role(db, principal.user.id, item_id, "MEMBER")
    body = payload.body.strip()
    if not body:
        raise ApiError(422, "VALIDATION_ERROR", "Invalid request", {"body": ["Must not be blank"]})
    comment = Comment(work_item_id=item.id, author_id=principal.user.id, body=body)
    db.add(comment)
    db.flush()
    log_event(
        db, item.id, principal.user.id, "COMMENTED", None, {"commentId": comment.id}
    )
    db.commit()
    return {
        "id": comment.id,
        "work_item_id": comment.work_item_id,
        "author_id": comment.author_id,
        "body": comment.body,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat(),
    }
