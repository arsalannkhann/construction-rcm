import { Lock } from 'lucide-react';
import { can, ROLE_LABEL, type Permission } from '@/server/auth/permissions';
import { ROLES, type Role } from '@/server/types';
import { Notice } from './notice';

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Explains why a settings page is read-only for this person, and which roles can change it. */
export function PermissionNote({ role, permission, action, className }: { role: Role; permission: Permission; action: string; className?: string }) {
  const allowed = ROLES.filter((r) => can(r, permission)).map((r) => ROLE_LABEL[r]);
  return (
    <Notice icon={<Lock strokeWidth={1.9} />} className={className}>
      Your role ({ROLE_LABEL[role]}) can view this but cannot {action}. Roles that can: {list(allowed)}.
    </Notice>
  );
}
