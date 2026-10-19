"""Safely create a first team and user, or add a user to an existing team."""

import argparse
import re
from getpass import getpass

from argon2 import PasswordHasher
from sqlalchemy import select

from app.database import SessionLocal
from app.models import Membership, Team, User


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--team-name", required=True)
    parser.add_argument("--team-slug", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--role", choices=("VIEWER", "MEMBER", "LEAD", "ADMIN"), default="ADMIN")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.team_slug):
        parser.error("--team-slug must contain lowercase letters, numbers, and hyphens")
    password = getpass("Initial password (at least 16 characters): ")
    confirmation = getpass("Confirm password: ")
    if len(password) < 16 or password != confirmation:
        parser.error("Password confirmation failed or password is shorter than 16 characters")

    hasher = PasswordHasher()
    with SessionLocal.begin() as db:
        if db.scalar(select(User.id).where(User.email == args.email.strip().lower())):
            raise SystemExit("A user with that email already exists; no changes were made.")
        team = db.scalar(select(Team).where(Team.slug == args.team_slug))
        if team is None:
            team = Team(name=args.team_name.strip(), slug=args.team_slug)
            db.add(team)
            db.flush()
        user = User(
            name=args.name.strip(),
            email=args.email.strip().lower(),
            password_hash=hasher.hash(password),
        )
        db.add(user)
        db.flush()
        db.add(Membership(user_id=user.id, team_id=team.id, role=args.role))
    print(f"Created user and {args.role} membership in team {args.team_slug}.")


if __name__ == "__main__":
    main()
