import secrets
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import get_settings
from app.models import ActivityEvent, IdempotencyRecord, OutboxJob, WorkItem
from app.tests.conftest import TestSession


def csrf(client: TestClient) -> dict[str, str]:
    token = client.get("/api/v1/auth/csrf").json()["csrfToken"]
    return {"X-CSRF-Token": token}


def sign_in(client: TestClient, email: str) -> None:
    headers = csrf(client)
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "test-password-only"},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def headers(client: TestClient) -> dict[str, str]:
    return csrf(client)


def create_item(client: TestClient, team_id: int, title: str = "Test task", **body):
    return client.post(
        "/api/v1/items",
        json={"title": title, "teamId": team_id, **body},
        headers=headers(client),
    )


def test_login_cookie_session_csrf_and_logout(client, identities):
    user = identities["users"]["member"]
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.post(
        "/api/v1/auth/login", json={"email": user["email"], "password": "test-password-only"}
    ).status_code == 403
    sign_in(client, user["email"])
    assert client.cookies.get("newtonite_session")
    assert client.cookies.get("newtonite_csrf")
    assert client.get("/api/v1/auth/me").json()["user"]["id"] == user["id"]
    response = create_item(client, identities["team_id"], "CSRF protected")
    assert response.status_code == 201
    assert client.post(
        "/api/v1/auth/logout", headers=headers(client)
    ).status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_invalid_login_and_throttle(client, identities):
    email = identities["users"]["member"]["email"]
    for _ in range(3):
        response = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong-password"},
            headers=csrf(client),
        )
        assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_login_throttle_limit_returns_retry_after(client, identities):
    email = identities["users"]["member"]["email"]
    for _ in range(get_settings().login_max_failures):
        response = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong-password"},
            headers=csrf(client),
        )
        assert response.status_code == 401
    throttled = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "wrong-password"},
        headers=csrf(client),
    )
    assert throttled.status_code == 429
    assert int(throttled.headers["Retry-After"]) > 0
    assert throttled.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"


def test_team_scope_and_role_enforcement(client, identities):
    sign_in(client, identities["users"]["member"]["email"])
    created = create_item(client, identities["team_id"]).json()
    viewer = TestClient(client.app)
    sign_in(viewer, identities["users"]["viewer"]["email"])
    response = viewer.patch(
        f"/api/v1/items/{created['id']}",
        json={"expectedVersion": 1, "title": "Denied"},
        headers=headers(viewer),
    )
    assert response.status_code == 403
    outsider = TestClient(client.app)
    sign_in(outsider, identities["users"]["outsider"]["email"])
    assert outsider.get(f"/api/v1/items/{created['id']}").status_code == 404
    assert outsider.get("/api/v1/items").json()["data"] == []
    assert create_item(outsider, identities["team_id"]).status_code == 403


def test_claim_race_has_single_winner_and_history(client, identities):
    sign_in(client, identities["users"]["member"]["email"])
    item = create_item(client, identities["team_id"]).json()
    clients = [client]
    for label in ("member2", "lead"):
        other = TestClient(client.app)
        sign_in(other, identities["users"][label]["email"])
        clients.append(other)
    with ThreadPoolExecutor(max_workers=9) as executor:
        responses = list(
            executor.map(
                lambda c: c.post(
                    f"/api/v1/items/{item['id']}/claim", headers=headers(c)
                ),
                clients * 3,
            )
        )
    assert sum(response.status_code == 200 for response in responses) == 1
    assert sum(
        response.status_code == 409
        and response.json()["error"]["code"] == "ALREADY_CLAIMED"
        for response in responses
    ) == 8
    with TestSession() as db:
        count = db.scalar(
            select(func.count()).select_from(ActivityEvent).where(
                ActivityEvent.work_item_id == item["id"],
                ActivityEvent.event_type == "CLAIMED",
            )
        )
    assert count == 1


def test_optimistic_lock_and_no_op_version(client, identities):
    sign_in(client, identities["users"]["member"]["email"])
    item = create_item(client, identities["team_id"]).json()
    updated = client.patch(
        f"/api/v1/items/{item['id']}",
        json={"expectedVersion": 1, "title": "Updated"},
        headers=headers(client),
    )
    assert updated.status_code == 200 and updated.json()["version"] == 2
    stale = client.patch(
        f"/api/v1/items/{item['id']}",
        json={"expectedVersion": 1, "title": "Lost"},
        headers=headers(client),
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "STALE_VERSION"
    no_op = client.patch(
        f"/api/v1/items/{item['id']}",
        json={"expectedVersion": 2, "title": "Updated"},
        headers=headers(client),
    )
    assert no_op.status_code == 200 and no_op.json()["version"] == 2
    assert client.patch(
        f"/api/v1/items/{item['id']}",
        json={"expectedVersion": 2, "status": "CLOSED"},
        headers=headers(client),
    ).status_code == 422


def test_create_idempotency_and_transactional_activity(client, identities):
    sign_in(client, identities["users"]["member"]["email"])
    key = f"test-{secrets.token_hex(8)}"
    data = {"title": "Idempotent", "teamId": identities["team_id"]}
    first = client.post(
        "/api/v1/items", json=data, headers={**headers(client), "Idempotency-Key": key}
    )
    replay = client.post(
        "/api/v1/items", json=data, headers={**headers(client), "Idempotency-Key": key}
    )
    assert first.status_code == 201 and replay.status_code == 201
    assert first.json()["id"] == replay.json()["id"]
    assert replay.headers["Idempotent-Replay"] == "true"
    conflict = client.post(
        "/api/v1/items",
        json={**data, "title": "Different"},
        headers={**headers(client), "Idempotency-Key": key},
    )
    assert conflict.status_code == 409
    with TestSession() as db:
        item = db.get(WorkItem, first.json()["id"])
        events = db.scalars(
            select(ActivityEvent).where(ActivityEvent.work_item_id == item.id)
        ).all()
        jobs = db.scalars(
            select(OutboxJob).where(OutboxJob.payload["itemId"].astext == str(item.id))
        ).all()
        records = db.scalars(
            select(IdempotencyRecord).where(IdempotencyRecord.key == key)
        ).all()
        assert len(events) == len(jobs) == len(records) == 1


def test_workflow_lead_approval_and_comment_activity(client, identities):
    sign_in(client, identities["users"]["member"]["email"])
    item = create_item(client, identities["team_id"]).json()
    for target in ("IN_PROGRESS", "AWAITING_APPROVAL"):
        item = client.post(
            f"/api/v1/items/{item['id']}/transition",
            json={"to": target, "expectedVersion": item["version"]},
            headers=headers(client),
        ).json()
    denied = client.post(
        f"/api/v1/items/{item['id']}/transition",
        json={"to": "RESOLVED", "expectedVersion": item["version"]},
        headers=headers(client),
    )
    assert denied.status_code == 403
    lead = TestClient(client.app)
    sign_in(lead, identities["users"]["lead"]["email"])
    approved = lead.post(
        f"/api/v1/items/{item['id']}/transition",
        json={"to": "RESOLVED", "expectedVersion": item["version"]},
        headers=headers(lead),
    )
    assert approved.status_code == 200
    comment = lead.post(
        f"/api/v1/items/{item['id']}/comments",
        json={"body": "Approval completed"},
        headers=headers(lead),
    )
    assert comment.status_code == 201
    listed_comments = lead.get(f"/api/v1/items/{item['id']}/comments").json()["data"]
    assert len(listed_comments) == 1
    assert listed_comments[0]["body"] == "Approval completed"
    history = lead.get(f"/api/v1/items/{item['id']}/activity").json()["data"]
    assert any(entry["event_type"] == "APPROVED" for entry in history)
    assert any(entry["event_type"] == "COMMENTED" for entry in history)


def test_filters_search_cursor_and_dashboard(client, identities):
    sign_in(client, identities["users"]["member"]["email"])
    for index in range(4):
        assert create_item(
            client,
            identities["team_id"],
            f"Queue marker {index}",
            priority="URGENT" if index == 0 else "LOW",
        ).status_code == 201
    page = client.get("/api/v1/items?q=Queue%20marker&limit=2").json()
    assert len(page["data"]) == 2 and page["nextCursor"]
    next_page = client.get(
        f"/api/v1/items?q=Queue%20marker&limit=2&cursor={page['nextCursor']}"
    ).json()
    assert len(next_page["data"]) == 2
    assert {row["id"] for row in page["data"]}.isdisjoint(
        {row["id"] for row in next_page["data"]}
    )
    summary = client.get("/api/v1/dashboard/summary").json()
    assert set(summary) == {
        "assignedToMe", "unassignedUrgent", "awaitingMyApproval", "overdue"
    }
