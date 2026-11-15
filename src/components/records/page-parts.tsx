import { ArrowLeft, Lock } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { EmptyState, Panel } from '@/components/ui/data';
import { can, ROLE_LABEL } from '@/server/auth/permissions';
import { ROLES, type Role } from '@/server/types';

/** The "back to …" link shown above a page title. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="focus-ring inline-flex items-center gap-1 rounded-sm hover:text-ink">
      <ArrowLeft className="size-3.5" strokeWidth={1.9} />
      {children}
    </Link>
  );
}

/** Shown in place of a form when the signed-in role cannot change projects and contracts. */
export function CannotEditRecords({ role, what }: { role: Role; what: string }) {
  const allowed = ROLES.filter((r) => can(r, 'records:write')).map((r) => ROLE_LABEL[r].toLowerCase());
  const list = allowed.length > 1 ? `${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}` : (allowed[0] ?? 'administrator');
  return (
    <Panel>
      <EmptyState
        icon={<Lock />}
        title={`Your role cannot ${what}`}
        description={`You are signed in as ${ROLE_LABEL[role].toLowerCase()}. Ask someone with the ${list} role to do this, or to change your role.`}
      />
    </Panel>
  );
}
