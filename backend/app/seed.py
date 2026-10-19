"""Additive local demo data creation. This command never clears or resets records."""

import argparse
import logging

from argon2 import PasswordHasher
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.config import get_settings
from app.database import SessionLocal
from app.models import ActivityEvent, Membership, Team, User, WorkItem

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("newtonite.seed")

PASSWORD = "demo-local-only"
TEAMS = (
    ("Platform", "platform", "Infrastructure and reliability"),
    ("Support", "support", "Customer escalations"),
    ("Security", "security", "Security reviews and incidents"),
)
USERS = (
    ("Ada Admin", "admin@demo.test", (("platform", "ADMIN"), ("support", "ADMIN"), ("security", "ADMIN"))),
    ("Lena Lead", "lead@demo.test", (("platform", "LEAD"), ("support", "MEMBER"))),
    ("Sam Support Lead", "support.lead@demo.test", (("support", "LEAD"),)),
    ("Maya Member", "member@demo.test", (("platform", "MEMBER"), ("support", "MEMBER"))),
    ("Omar Member", "member2@demo.test", (("platform", "MEMBER"),)),
    ("Priya Security", "security@demo.test", (("security", "LEAD"),)),
    ("Vik Viewer", "viewer@demo.test", (("platform", "VIEWER"), ("support", "VIEWER"))),
    ("Nora Newhire", "nora@demo.test", (("support", "MEMBER"), ("security", "MEMBER"))),
)
SUBJECTS = (
    "Database failover alert",
    "Customer data export stuck",
    "Rotate expiring TLS certificates",
    "Investigate login latency",
    "Refund escalation",
    "Review vendor access",
    "Disk usage above 85%",
    "Webhook retries failing",
    "Audit admin permissions",
    "Onboarding checklist gaps",
)


def seed(item_count: int) -> None:
    settings = get_settings()
    if settings.app_env.lower() != "development":
        raise RuntimeError("Demo seeding is restricted to APP_ENV=development")
    hasher = PasswordHasher()
    with SessionLocal.begin() as db:
        db.execute(
            insert(Team)
            .values(
                [
                    {"name": name, "slug": slug, "description": description}
                    for name, slug, description in TEAMS
                ]
            )
            .on_conflict_do_nothing(index_elements=[Team.slug])
        )
        teams = {
            team.slug: team.id
            for team in db.scalars(select(Team).where(Team.slug.in_([row[1] for row in TEAMS])))
        }
        for name, email, _ in USERS:
            existing = db.scalar(select(User).where(User.email == email))
            if existing is None:
                db.add(User(name=name, email=email, password_hash=hasher.hash(PASSWORD)))
        db.flush()
        users = {user.email: user for user in db.scalars(select(User).where(User.email.in_([u[1] for u in USERS])))}
        membership_rows = [
            {"user_id": users[email].id, "team_id": teams[slug], "role": role}
            for _name, email, memberships in USERS
            for slug, role in memberships
        ]
        db.execute(
            insert(Membership)
            .values(membership_rows)
            .on_conflict_do_nothing(index_elements=[Membership.user_id, Membership.team_id])
        )
        members = db.execute(
            select(Membership.user_id, Membership.team_id)
            .where(Membership.role != "VIEWER")
            .order_by(Membership.id)
        ).all()
        states = ("OPEN", "OPEN", "IN_PROGRESS", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED")
        priorities = ("LOW", "MEDIUM", "MEDIUM", "HIGH", "URGENT")
        demo_titles = {
            f"{SUBJECTS[index % len(SUBJECTS)]} [demo #{index:05d}]"
            for index in range(item_count)
        }
        existing_titles = set(db.scalars(select(WorkItem.title).where(WorkItem.title.in_(demo_titles))))
        for index in range(item_count):
            title = f"{SUBJECTS[index % len(SUBJECTS)]} [demo #{index:05d}]"
            if title in existing_titles:
                continue
            user_id, team_id = members[index % len(members)]
            status = states[index % len(states)]
            item = WorkItem(
                title=title,
                description=f"{SUBJECTS[index % len(SUBJECTS)]}. Seeded local demo record.",
                priority=priorities[index % len(priorities)],
                type="INCIDENT" if index % 2 else "TASK",
                status=status,
                team_id=team_id,
                assignee_id=user_id if status != "OPEN" or index % 3 == 0 else None,
                created_by_id=user_id,
            )
            db.add(item)
            db.flush()
            db.add(
                ActivityEvent(
                    work_item_id=item.id,
                    actor_id=user_id,
                    event_type="CREATED",
                    new_value={"seed": True},
                )
            )
            existing_titles.add(title)
    logger.info("Demo seed ensured %s teams, %s accounts, and up to %s work items.", len(TEAMS), len(USERS), item_count)


def main() -> None:
    parser = argparse.ArgumentParser(description="Add local Newtonite Ops demo data without deleting records.")
    parser.add_argument("--large", action="store_true", help="Add up to 5,000 deterministic demo work items.")
    args = parser.parse_args()
    seed(5000 if args.large else 48)


if __name__ == "__main__":
    main()
