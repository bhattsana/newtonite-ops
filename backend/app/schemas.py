from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Role = Literal["VIEWER", "MEMBER", "LEAD", "ADMIN"]
Status = Literal["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"]
Priority = Literal["LOW", "MEDIUM", "HIGH", "URGENT"]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LoginRequest(StrictRequest):
    email: str
    password: str = Field(min_length=1)


class UserOut(BaseModel):
    id: int
    name: str
    email: str | None = None


class MembershipOut(BaseModel):
    team_id: int
    role: Role


class MeOut(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]


class CreateItemRequest(StrictRequest):
    title: Title
    description: str = Field(default="", max_length=10000)
    priority: Priority = "MEDIUM"
    type: str = Field(default="TASK", max_length=40)
    team_id: int = Field(alias="teamId")
    due_at: datetime | None = Field(default=None, alias="dueAt")


class PatchItemRequest(StrictRequest):
    expected_version: int = Field(alias="expectedVersion", ge=1)
    title: Title | None = None
    description: str | None = Field(default=None, max_length=10000)
    priority: Priority | None = None
    due_at: datetime | None = Field(default=None, alias="dueAt")
    assignee_id: int | None = Field(default=None, alias="assigneeId")


class TransitionRequest(StrictRequest):
    to: Status
    expected_version: int = Field(alias="expectedVersion", ge=1)
    note: str | None = Field(default=None, max_length=1000)


class CommentRequest(StrictRequest):
    body: str = Field(min_length=1, max_length=5000)


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    reference: str
    title: str
    description: str
    type: str
    priority: Priority
    status: Status
    team_id: int
    assignee_id: int | None
    created_by_id: int
    due_at: datetime | None
    version: int
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None
    assignee_name: str | None = None


class ActivityOut(BaseModel):
    id: int
    event_type: str
    actor_name: str
    previous_value: Any
    new_value: Any
    metadata: dict[str, Any] | None
    created_at: datetime


class CommentOut(BaseModel):
    id: int
    author_id: int
    body: str
    created_at: datetime
    updated_at: datetime


class TeamOut(BaseModel):
    id: int
    name: str
    slug: str
    description: str | None
    role: Role


class DashboardStatusCounts(BaseModel):
    OPEN: int
    IN_PROGRESS: int
    AWAITING_APPROVAL: int
    RESOLVED: int
    CLOSED: int


class IntelligenceItemOut(BaseModel):
    id: int
    reference: str
    title: str
    status: Status
    priority: Priority
    teamId: int
    teamName: str
    assigneeName: str | None
    dueAt: datetime | None
    score: int
    factors: list[str]
    statusAgeDays: int


class DeadlineItemOut(BaseModel):
    id: int
    reference: str
    title: str
    status: Status
    priority: Priority
    dueAt: datetime
    teamId: int
    teamName: str
    assigneeName: str | None
    risk: Literal["OVERDUE", "AT_RISK", "UPCOMING"]


class BottleneckOut(BaseModel):
    key: str
    title: str
    count: int
    evidence: str
    recommendation: str
    status: Status


class TeamWorkloadOut(BaseModel):
    teamId: int
    teamName: str
    active: int
    highPriority: int
    unassigned: int
    overdue: int
    awaitingApproval: int


class AssigneeWorkloadOut(BaseModel):
    assigneeId: int
    assigneeName: str
    active: int
    highPriority: int


class TrendDayOut(BaseModel):
    date: str
    created: int
    completed: int


class DashboardSummaryOut(BaseModel):
    critical_high: int = Field(alias="criticalHigh")
    assigned_to_me: int = Field(alias="assignedToMe")
    unassigned_urgent: int = Field(alias="unassignedUrgent")
    awaiting_my_approval: int = Field(alias="awaitingMyApproval")
    overdue: int
    active_total: int = Field(alias="activeTotal")
    status_counts: DashboardStatusCounts = Field(alias="statusCounts")
    last_updated_at: datetime | None = Field(alias="lastUpdatedAt")
    intelligence: list[IntelligenceItemOut]
    deadline_watch: list[DeadlineItemOut] = Field(alias="deadlineWatch")
    bottlenecks: list[BottleneckOut]
    team_workload: list[TeamWorkloadOut] = Field(alias="teamWorkload")
    assignee_workload: list[AssigneeWorkloadOut] = Field(alias="assigneeWorkload")
    trends: list[TrendDayOut]


class MemberOut(BaseModel):
    id: int
    name: str
    email: str
    role: Role
