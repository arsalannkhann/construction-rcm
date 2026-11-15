import type { Role } from '@/server/types';

export const PERMISSIONS = [
  'org:manage',
  'team:manage',
  'integrations:manage',
  'policy:manage',
  'records:write',
  'application:upload',
  'application:review',
  'application:approve',
  'compliance:signoff',
  'export:run',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: [...PERMISSIONS],
  controller: [
    'policy:manage',
    'records:write',
    'application:upload',
    'application:review',
    'application:approve',
    'compliance:signoff',
    'export:run',
  ],
  accountant: ['records:write', 'application:upload', 'application:review', 'export:run'],
  project_manager: ['application:upload'],
  viewer: [],
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  controller: 'Controller',
  accountant: 'Project accountant',
  project_manager: 'Project manager',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Full access, including organisation settings and ownership.',
  admin: 'Full access: team, integrations, policies, approvals.',
  controller: 'Approves or rejects applications, signs off overrides and compliance items, runs exports.',
  accountant: 'Reviews applications, corrects data, requests fixes and submits for approval. Cannot approve.',
  project_manager: 'Uploads billing packages and comments. Read-only on financial data.',
  viewer: 'Read-only access.',
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role]?.includes(permission) ?? false;
}

export class PermissionError extends Error {
  constructor(public permission: Permission) {
    super('You do not have permission to do that.');
    this.name = 'PermissionError';
  }
}

/** The acting user within one organisation. Every service call takes one. */
export type Ctx = {
  orgId: string;
  orgName: string;
  isDemo: boolean;
  userId: string;
  userName: string;
  userEmail: string;
  role: Role;
};

export function assertCan(ctx: Ctx, permission: Permission): void {
  if (!can(ctx.role, permission)) throw new PermissionError(permission);
}

/** Errors whose message is safe and useful to show to the user. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
