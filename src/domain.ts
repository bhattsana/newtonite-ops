import type { Role, Status } from '../shared/types.js';
export type { Role, Status };
const RANK: Record<Role, number> = { VIEWER: 1, MEMBER: 2, LEAD: 3, ADMIN: 4 };
export const atLeast = (r: Role, min: Role) => RANK[r] >= RANK[min];
// Single source of truth for the workflow. `min` is the minimum team role to perform the transition.
export const TRANSITIONS: Record<Status, Partial<Record<Status, Role>>> = {
  OPEN: { IN_PROGRESS: 'MEMBER' },
  IN_PROGRESS: { OPEN: 'MEMBER', AWAITING_APPROVAL: 'MEMBER' },
  AWAITING_APPROVAL: { RESOLVED: 'LEAD', IN_PROGRESS: 'LEAD' }, // approval / rejection are Lead-only
  RESOLVED: { CLOSED: 'MEMBER', IN_PROGRESS: 'LEAD' },
  CLOSED: {},
};
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
