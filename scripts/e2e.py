"""Exercise real FastAPI/PostgreSQL workflows against a running development API."""

from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
import json
import os
import secrets
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener


BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "demo-local-only")


class Api:
    def __init__(self) -> None:
        self.cookies = CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookies))
        self.csrf = self.request("GET", "/api/v1/auth/csrf")[1]["csrfToken"]

    def request(
        self, method: str, path: str, body: dict | None = None, headers: dict | None = None
    ) -> tuple[int, dict, dict]:
        request_headers = {"Accept": "application/json", **(headers or {})}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        if method not in ("GET", "HEAD", "OPTIONS"):
            request_headers["X-CSRF-Token"] = self.csrf
        data = json.dumps(body).encode() if body is not None else None
        request = Request(
            f"{BASE_URL}{path}", data=data, method=method, headers=request_headers
        )
        try:
            response = self.opener.open(request, timeout=10)
        except HTTPError as error:
            response = error
        raw = response.read()
        parsed = json.loads(raw) if raw else {}
        return response.status, parsed, dict(response.headers.items())

    def sign_in(self, email: str) -> None:
        status, _, _ = self.request(
            "POST",
            "/api/v1/auth/login",
            {"email": email, "password": DEMO_PASSWORD},
        )
        assert status == 200, f"Login failed for demo role ({status})"


def expect(label: str, response: tuple[int, dict, dict], status: int) -> dict:
    actual, data, _ = response
    assert actual == status, f"{label}: expected HTTP {status}, got {actual}"
    print(f"PASS {label}")
    return data


def login(email: str) -> Api:
    client = Api()
    client.sign_in(email)
    return client


def main() -> None:
    try:
        status, health, _ = Api().request("GET", "/health")
    except (URLError, TimeoutError) as error:
        raise SystemExit(
            f"Cannot reach {BASE_URL}; start the API and its PostgreSQL database first."
        ) from error
    assert status == 200 and health.get("ok") is True, "API health check failed"
    print("PASS API health and PostgreSQL connectivity")

    member = login("member@demo.test")
    dashboard = expect(
        "authenticated dashboard summary",
        member.request("GET", "/api/v1/dashboard/summary"),
        200,
    )
    assert set(dashboard) == {
        "assignedToMe", "unassignedUrgent", "awaitingMyApproval", "overdue"
    }
    teams = expect("team-scoped team listing", member.request("GET", "/api/v1/teams"), 200)
    platform = next(team for team in teams["data"] if team["slug"] == "platform")
    team_id = platform["id"]
    members = expect(
        "team member listing",
        member.request("GET", f"/api/v1/teams/{team_id}/members"),
        200,
    )["data"]
    assignee_id = next(user["id"] for user in members if user["email"] == "member2@demo.test")

    suffix = secrets.token_hex(5)
    title = f"e2e verification {suffix}"
    item = expect(
        "database-backed work-item creation",
        member.request(
            "POST",
            "/api/v1/items",
            {"title": title, "teamId": team_id, "description": "Automated API smoke check"},
            {"Idempotency-Key": f"e2e-create-{suffix}"},
        ),
        201,
    )
    replay = expect(
        "idempotent duplicate submission",
        member.request(
            "POST",
            "/api/v1/items",
            {"title": title, "teamId": team_id, "description": "Automated API smoke check"},
            {"Idempotency-Key": f"e2e-create-{suffix}"},
        ),
        201,
    )
    assert replay["id"] == item["id"]
    search = urlencode({"q": title, "limit": 1})
    listed = expect(
        "search and pagination response",
        member.request("GET", f"/api/v1/items?{search}"),
        200,
    )
    assert any(row["id"] == item["id"] for row in listed["data"])
    first_page = expect(
        "first cursor page",
        member.request("GET", "/api/v1/items?limit=1"),
        200,
    )
    assert len(first_page["data"]) == 1 and first_page["nextCursor"] is not None
    second_page = expect(
        "second cursor page",
        member.request(
            "GET", f"/api/v1/items?limit=1&cursor={first_page['nextCursor']}"
        ),
        200,
    )
    assert len(second_page["data"]) == 1
    assert first_page["data"][0]["id"] != second_page["data"][0]["id"]
    print("PASS distinct keyset pagination pages")
    expect(
        "member assignment restriction",
        member.request(
            "PATCH",
            f"/api/v1/items/{item['id']}",
            {"expectedVersion": item["version"], "assigneeId": assignee_id},
        ),
        403,
    )
    lead = login("lead@demo.test")
    update = expect(
        "assignment and optimistic update",
        lead.request(
            "PATCH",
            f"/api/v1/items/{item['id']}",
            {"expectedVersion": item["version"], "assigneeId": assignee_id},
        ),
        200,
    )
    stale = member.request(
        "PATCH",
        f"/api/v1/items/{item['id']}",
        {"expectedVersion": item["version"], "title": "stale update"},
    )
    expect("stale update conflict", stale, 409)
    assert update["assignee_id"] == assignee_id

    current = update
    for target in ("IN_PROGRESS", "AWAITING_APPROVAL"):
        current = expect(
            f"workflow transition to {target}",
            member.request(
                "POST",
                f"/api/v1/items/{item['id']}/transition",
                {"to": target, "expectedVersion": current["version"]},
            ),
            200,
        )
    expect(
        "member approval restriction",
        member.request(
            "POST",
            f"/api/v1/items/{item['id']}/transition",
            {"to": "RESOLVED", "expectedVersion": current["version"]},
        ),
        403,
    )
    resolved = expect(
        "lead-only approval",
        lead.request(
            "POST",
            f"/api/v1/items/{item['id']}/transition",
            {"to": "RESOLVED", "expectedVersion": current["version"]},
        ),
        200,
    )
    expect(
        "comment creation",
        lead.request(
            "POST",
            f"/api/v1/items/{item['id']}/comments",
            {"body": "E2E approval history"},
        ),
        201,
    )
    activity = expect(
        "transactional activity history",
        lead.request("GET", f"/api/v1/items/{item['id']}/activity"),
        200,
    )["data"]
    assert any(event["event_type"] == "APPROVED" for event in activity)
    assert resolved["status"] == "RESOLVED"

    claim_item = expect(
        "claim-race work-item creation",
        member.request(
            "POST",
            "/api/v1/items",
            {"title": f"e2e claim {suffix}", "teamId": team_id},
        ),
        201,
    )
    claimant_a = login("member2@demo.test")
    claimant_b = login("lead@demo.test")
    with ThreadPoolExecutor(max_workers=2) as pool:
        claim_responses = list(
            pool.map(
                lambda client: client.request(
                    "POST", f"/api/v1/items/{claim_item['id']}/claim"
                ),
                (claimant_a, claimant_b),
            )
        )
    codes = sorted(response[0] for response in claim_responses)
    assert codes == [200, 409], f"Expected one claim winner and one conflict, got {codes}"
    print("PASS concurrent claim has one winner")

    viewer = login("viewer@demo.test")
    expect(
        "viewer write restriction",
        viewer.request(
            "PATCH",
            f"/api/v1/items/{claim_item['id']}",
            {"expectedVersion": claim_item["version"], "title": "unauthorized"},
        ),
        403,
    )
    outsider = login("nora@demo.test")
    expect(
        "cross-team item isolation",
        outsider.request("GET", f"/api/v1/items/{item['id']}"),
        404,
    )
    expect("logout", member.request("POST", "/api/v1/auth/logout"), 204)
    expect("protected route after logout", member.request("GET", "/api/v1/auth/me"), 401)
    print("All HTTP end-to-end checks passed.")


if __name__ == "__main__":
    main()
