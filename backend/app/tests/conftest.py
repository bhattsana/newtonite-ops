import os
import secrets
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.database import SessionLocal
from app.main import app
from app.models import Membership, Team, User, WorkItem

database_url = os.environ.get("DATABASE_URL", "")
if not database_url:
    raise RuntimeError("Set DATABASE_URL to a dedicated PostgreSQL test database ending in _test.")

_engine = create_engine(database_url, pool_pre_ping=True)
with _engine.connect() as _connection:
    _database_name = _connection.execute(text("SELECT current_database()")).scalar_one()
if not _database_name.lower().endswith(("_test", "-test")):
    raise RuntimeError("Tests refuse to connect: DATABASE_URL must target a dedicated database ending in _test.")
_engine.dispose()

config = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
command.upgrade(config, "head")
TestSession = sessionmaker(bind=SessionLocal.kw["bind"], expire_on_commit=False)
hasher = PasswordHasher()


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def identities():
    suffix = secrets.token_hex(5)
    with TestSession.begin() as db:
        alpha = Team(name=f"Alpha {suffix}", slug=f"alpha-{suffix}")
        beta = Team(name=f"Beta {suffix}", slug=f"beta-{suffix}")
        db.add_all((alpha, beta))
        db.flush()
        accounts: dict[str, User] = {}
        roles = {"member": "MEMBER", "member2": "MEMBER", "lead": "LEAD", "viewer": "VIEWER", "outsider": "MEMBER"}
        for label, role in roles.items():
            user = User(
                name=f"{label.title()} {suffix}",
                email=f"{label}-{suffix}@test.invalid",
                password_hash=hasher.hash("test-password-only"),
            )
            db.add(user)
            db.flush()
            db.add(
                Membership(
                    user_id=user.id,
                    team_id=beta.id if label == "outsider" else alpha.id,
                    role=role,
                )
            )
            accounts[label] = user
        db.flush()
        data = {
            "team_id": alpha.id,
            "other_team_id": beta.id,
            "users": {key: {"id": value.id, "email": value.email} for key, value in accounts.items()},
        }
    return data


@pytest.fixture
def create_work_item():
    def create(db: Session, team_id: int, created_by_id: int, **kwargs) -> WorkItem:
        item = WorkItem(
            title=kwargs.pop("title", f"Test work {secrets.token_hex(4)}"),
            team_id=team_id,
            created_by_id=created_by_id,
            **kwargs,
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    return create
