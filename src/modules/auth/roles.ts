export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * viewer: read workflows and executions.
 * editor: + create/edit/run workflows, manage credentials.
 * admin:  + invite and manage members (not owners).
 * owner:  + manage admins and owners.
 */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** What a guarded request knows about its caller. */
export interface AuthContext {
  userId: string;
  workspaceId: string;
  role: Role;
}
