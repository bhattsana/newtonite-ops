// Single source of truth for API shapes, imported by BOTH the API (src/) and the web app (web/src/api.ts).
// The *_KEYS arrays below are checked against the real HTTP responses in tests/api.test.ts, so the API and
// the frontend cannot silently disagree about field names. (Key presence is verified; value types are not.)
export type Role = 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN';
export type Status = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface Item {
  id: number; reference: string; title: string; description: string; type: string; priority: Priority; status: Status;
  team_id: number; assignee_id: number | null; created_by_id: number; due_at: string | null; version: number;
  created_at: string; updated_at: string; resolved_at: string | null;
  assignee_name?: string | null; // list endpoint only
}
export interface ItemList { data: Item[]; nextCursor: number | null }
export interface Me { user: { id: number; name: string }; memberships: { team_id: number; role: Role }[] }
export interface Team { id: number; name: string; slug: string; description: string | null; role: Role }
export interface Member { id: number; name: string; email: string; role: Role }
export interface Activity { id: number; event_type: string; actor_name: string; previous_value: unknown; new_value: unknown; metadata: { note?: string } | null; created_at: string }
export interface Comment { id: number; author_id: number; body: string; created_at: string }
export interface DashboardSummary { assignedToMe: number; unassignedUrgent: number; awaitingMyApproval: number; overdue: number }

export const ITEM_KEYS = ['id', 'reference', 'title', 'description', 'type', 'priority', 'status', 'team_id', 'assignee_id', 'created_by_id', 'due_at', 'version', 'created_at', 'updated_at', 'resolved_at'] as const satisfies readonly (keyof Item)[];
export const ACTIVITY_KEYS = ['id', 'event_type', 'actor_name', 'previous_value', 'new_value', 'metadata', 'created_at'] as const satisfies readonly (keyof Activity)[];
export const COMMENT_KEYS = ['id', 'author_id', 'body', 'created_at'] as const satisfies readonly (keyof Comment)[];
export const TEAM_KEYS = ['id', 'name', 'slug', 'description', 'role'] as const satisfies readonly (keyof Team)[];
export const MEMBER_KEYS = ['id', 'name', 'email', 'role'] as const satisfies readonly (keyof Member)[];
export const ME_KEYS = ['user', 'memberships'] as const satisfies readonly (keyof Me)[];
export const SUMMARY_KEYS = ['assignedToMe', 'unassignedUrgent', 'awaitingMyApproval', 'overdue'] as const satisfies readonly (keyof DashboardSummary)[];
// Compile error if a field is added to Item without being added to ITEM_KEYS:
export const _itemKeysComplete: Exclude<keyof Item, 'assignee_name' | (typeof ITEM_KEYS)[number]> extends never ? true : false = true;
