/** In-app notifications. Created by the system as a side effect of workflow events. */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { memberships, notifications } from '@/db/schema';
import { can, type Ctx, type Permission } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import type { Role } from '@/server/types';

export type NotificationInput = { type: string; title: string; body?: string | null; href?: string | null };

export async function notifyUsers(db: DB, orgId: string, userIds: Array<string | null | undefined>, n: NotificationInput, at?: Date): Promise<void> {
  const unique = [...new Set(userIds.filter((u): u is string => !!u))];
  if (unique.length === 0) return;
  await db.insert(notifications).values(
    unique.map((userId) => ({ id: newId('ntf'), orgId, userId, type: n.type, title: n.title, body: n.body ?? null, href: n.href ?? null, createdAt: at ?? new Date() })),
  );
}

/** Active members of the organisation who hold a permission. */
export async function membersWith(db: DB, orgId: string, permission: Permission): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, 'active')));
  return rows.filter((r) => can(r.role as Role, permission)).map((r) => r.userId);
}

export async function notifyPermission(db: DB, orgId: string, permission: Permission, n: NotificationInput, opts: { except?: string | null; at?: Date } = {}): Promise<void> {
  const ids = (await membersWith(db, orgId, permission)).filter((id) => id !== opts.except);
  await notifyUsers(db, orgId, ids, n, opts.at);
}

export async function listNotifications(db: DB, ctx: Ctx, limit = 30) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, ctx.orgId), eq(notifications.userId, ctx.userId)))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function unreadCount(db: DB, ctx: Ctx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.orgId, ctx.orgId), eq(notifications.userId, ctx.userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

export async function markRead(db: DB, ctx: Ctx, ids?: string[]): Promise<void> {
  const mine = and(eq(notifications.orgId, ctx.orgId), eq(notifications.userId, ctx.userId), isNull(notifications.readAt));
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(ids && ids.length > 0 ? and(mine, inArray(notifications.id, ids)) : mine);
}
