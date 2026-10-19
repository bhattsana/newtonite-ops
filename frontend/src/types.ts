export type Role = "VIEWER" | "MEMBER" | "LEAD" | "ADMIN";
export type Status = "OPEN" | "IN_PROGRESS" | "AWAITING_APPROVAL" | "RESOLVED" | "CLOSED";
export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export interface Item {
  id: number;
  reference: string;
  title: string;
  description: string;
  type: string;
  priority: Priority;
  status: Status;
  team_id: number;
  assignee_id: number | null;
  created_by_id: number;
  due_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  assignee_name?: string | null;
}

export interface ItemList { data: Item[]; nextCursor: number | null }
export interface Me { user: { id: number; name: string }; memberships: { team_id: number; role: Role }[] }
export interface Team { id: number; name: string; slug: string; description: string | null; role: Role }
export interface Member { id: number; name: string; email: string; role: Role }
export interface Activity { id: number; event_type: string; actor_name: string; previous_value: unknown; new_value: unknown; metadata: { note?: string } | null; created_at: string }
export interface Comment { id: number; author_id: number; body: string; created_at: string }
export interface DashboardSummary { assignedToMe: number; unassignedUrgent: number; awaitingMyApproval: number; overdue: number }
