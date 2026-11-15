import { getDb } from '@/db';
import { AppShell } from '@/components/shell/app-shell';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { listNotifications, unreadCount } from '@/server/services/notify';
import { queueCounts } from '@/server/services/queries';
import { listMyOrganizations } from '@/server/services/team';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const db = await getDb();
  const organizations = await listMyOrganizations(db, ctx.userId);
  const unread = await unreadCount(db, ctx);
  const notifications = await listNotifications(db, ctx, 12);
  const counts = await queueCounts(db, ctx);
  const attention = counts.needs_matching + counts.needs_review + (can(ctx.role, 'application:approve') ? counts.pending_approval : 0);

  return (
    <AppShell
      user={{ name: ctx.userName, email: ctx.userEmail, role: ctx.role }}
      org={{ id: ctx.orgId, name: ctx.orgName, isDemo: ctx.isDemo }}
      organizations={organizations.map((o) => ({ id: o.id, name: o.name, isDemo: o.isDemo }))}
      attention={attention}
      unread={unread}
      notifications={notifications.map((n) => ({ id: n.id, title: n.title, body: n.body, href: n.href, read: !!n.readAt, createdAt: n.createdAt.toISOString() }))}
      canUpload={can(ctx.role, 'application:upload')}
    >
      {children}
    </AppShell>
  );
}
