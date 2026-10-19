from typing import Literal

Role = Literal["VIEWER", "MEMBER", "LEAD", "ADMIN"]
Status = Literal["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"]

ROLE_RANK: dict[str, int] = {"VIEWER": 1, "MEMBER": 2, "LEAD": 3, "ADMIN": 4}
TRANSITIONS: dict[str, dict[str, Role]] = {
    "OPEN": {"IN_PROGRESS": "MEMBER"},
    "IN_PROGRESS": {"OPEN": "MEMBER", "AWAITING_APPROVAL": "MEMBER"},
    "AWAITING_APPROVAL": {"RESOLVED": "LEAD", "IN_PROGRESS": "LEAD"},
    "RESOLVED": {"CLOSED": "MEMBER", "IN_PROGRESS": "LEAD"},
    "CLOSED": {},
}


def at_least(role: str, minimum: Role) -> bool:
    return ROLE_RANK.get(role, 0) >= ROLE_RANK[minimum]
