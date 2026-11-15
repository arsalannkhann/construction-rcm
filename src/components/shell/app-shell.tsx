'use client';

import { ArrowUpFromLine, Bell, Building2, Check, ChevronsUpDown, FlaskConical, History, Inbox, LayoutDashboard, LogOut, Plus, Send, Settings, Users } from 'lucide-react';
import Link from '@/components/ui/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { logoutAction, switchOrgAction } from '@/app/(auth)/actions';
import { markNotificationsReadAction } from '@/app/(app)/shell-actions';
import { BrandMark } from '@/components/brand';
import { Avatar } from '@/components/ui/data';
import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover, Tooltip } from '@/components/ui/overlay';
import { cn, formatRelative } from '@/lib/utils';
import { ROLE_LABEL } from '@/server/auth/permissions';
import type { Role } from '@/server/types';

type Org = { id: string; name: string; isDemo: boolean };
type Notice = { id: string; title: string; body: string | null; href: string | null; read: boolean; createdAt: string };

const NAV = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/applications', label: 'Pay applications', icon: Inbox },
  { href: '/projects', label: 'Projects', icon: Building2 },
  { href: '/subcontractors', label: 'Subcontractors', icon: Users },
  { href: '/transfers', label: 'Transfers', icon: Send },
  { href: '/activity', label: 'Activity', icon: History },
];

export function AppShell({
  user,
  org,
  organizations,
  attention,
  unread,
  notifications,
  canUpload,
  children,
}: {
  user: { name: string; email: string; role: Role };
  org: Org;
  organizations: Org[];
  attention: number;
  unread: number;
  notifications: Notice[];
  canUpload: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [, start] = useTransition();
  // The review workspace needs the width; the sidebar folds to a rail there.
  const rail = /^\/applications\/(?!new$)[^/]+$/.test(pathname);
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`) || (href === '/projects' && pathname.startsWith('/contracts'));

  const switchTo = (id: string) =>
    start(async () => {
      const result = await switchOrgAction(id);
      if (!result.ok) toast.error(result.error);
      else window.location.assign('/overview');
    });

  const item = (href: string, label: string, Icon: typeof Inbox, badge?: number) => {
    const on = active(href);
    const link = (
      <Link
        key={href}
        href={href}
        className={cn(
          'focus-ring group flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors',
          rail ? 'w-8 justify-center' : 'px-2',
          on ? 'bg-ink/[0.07] font-medium text-ink' : 'text-ink-2 hover:bg-ink/[0.045] hover:text-ink',
        )}
        aria-current={on ? 'page' : undefined}
      >
        <span className="relative">
          <Icon className={cn('size-4', on ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2')} strokeWidth={1.9} />
          {rail && badge ? <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-accent ring-2 ring-canvas" /> : null}
        </span>
        {rail ? null : <span className="flex-1 truncate">{label}</span>}
        {!rail && badge ? <span className="num rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white">{badge}</span> : null}
      </Link>
    );
    return rail ? (
      <Tooltip key={href} content={badge ? `${label} · ${badge} need attention` : label} side="right">
        {link}
      </Tooltip>
    ) : (
      link
    );
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={cn('flex shrink-0 flex-col border-r border-line bg-canvas transition-[width] duration-150', rail ? 'w-[52px] items-center px-0 py-3' : 'w-[232px] px-3 py-3')}>
        <Menu
          align="start"
          trigger={
            <button className={cn('focus-ring flex items-center gap-2 rounded-lg text-left hover:bg-ink/[0.045]', rail ? 'size-8 justify-center' : 'h-10 w-full px-2')} aria-label="Switch organisation">
              <BrandMark className={rail ? 'size-6' : 'size-6 shrink-0'} />
              {rail ? null : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold leading-4 text-ink">{org.name}</span>
                    <span className="block text-[11px] leading-4 text-ink-3">{org.isDemo ? 'Demo workspace' : ROLE_LABEL[user.role]}</span>
                  </span>
                  <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" />
                </>
              )}
            </button>
          }
        >
          <MenuLabel>Organisations</MenuLabel>
          {organizations.map((o) => (
            <MenuItem key={o.id} onSelect={() => (o.id === org.id ? undefined : switchTo(o.id))} icon={o.id === org.id ? <Check /> : o.isDemo ? <FlaskConical /> : <span />}>
              <span className="truncate">{o.name}</span>
              {o.isDemo ? <span className="ml-auto pl-3 text-[11px] text-ink-3">Demo</span> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => router.push('/settings/organization#demo')} icon={<FlaskConical />}>
            {organizations.some((o) => o.isDemo) ? 'About the demo workspace' : 'Explore a demo workspace'}
          </MenuItem>
        </Menu>

        {canUpload ? (
          rail ? (
            <Tooltip content="Upload a billing package" side="right">
              <Link href="/applications/new" className="focus-ring mt-3 flex size-8 items-center justify-center rounded-md bg-ink text-white hover:bg-ink/88" aria-label="Upload a billing package">
                <Plus className="size-4" />
              </Link>
            </Tooltip>
          ) : (
            <Link href="/applications/new" className="focus-ring mt-3 flex h-8 items-center justify-center gap-1.5 rounded-md bg-ink text-[13px] font-medium text-white hover:bg-ink/88">
              <ArrowUpFromLine className="size-3.5" />
              Upload package
            </Link>
          )
        ) : null}

        <nav className={cn('mt-4 flex flex-1 flex-col gap-0.5', rail && 'items-center')} aria-label="Main">
          {NAV.map((n) => item(n.href, n.label, n.icon, n.href === '/applications' ? attention : undefined))}
        </nav>

        <div className={cn('flex flex-col gap-0.5', rail && 'items-center')}>
          <NotificationsButton rail={rail} unread={unread} notifications={notifications} />
          {item('/settings', 'Settings', Settings)}
          <Menu
            align="start"
            side="top"
            trigger={
              <button className={cn('focus-ring mt-1 flex items-center gap-2 rounded-md text-left hover:bg-ink/[0.045]', rail ? 'size-8 justify-center' : 'h-9 w-full px-2')} aria-label="Account">
                <Avatar name={user.name} />
                {rail ? null : <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{user.name}</span>}
              </button>
            }
          >
            <div className="px-2 pb-1.5 pt-1">
              <div className="text-[13px] font-medium text-ink">{user.name}</div>
              <div className="text-xs text-ink-3">{user.email}</div>
            </div>
            <MenuSeparator />
            <MenuItem onSelect={() => router.push('/settings/profile')} icon={<Settings />}>
              Profile and password
            </MenuItem>
            <MenuItem onSelect={() => logoutAction()} icon={<LogOut />}>
              Sign out
            </MenuItem>
          </Menu>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {org.isDemo ? (
          <div className="flex shrink-0 items-center justify-center gap-2 border-b border-accent-line bg-accent-soft px-4 py-1.5 text-xs text-accent-ink">
            <FlaskConical className="size-3.5" />
            <span>
              <span className="font-medium">Demo workspace.</span> Fictitious companies and amounts, kept separate from your organisation’s records.
            </span>
            {organizations.find((o) => !o.isDemo) ? (
              <button className="font-medium underline underline-offset-2 hover:no-underline" onClick={() => switchTo(organizations.find((o) => !o.isDemo)!.id)}>
                Switch to {organizations.find((o) => !o.isDemo)!.name}
              </button>
            ) : null}
          </div>
        ) : null}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function NotificationsButton({ rail, unread, notifications }: { rail: boolean; unread: number; notifications: Notice[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [, start] = useTransition();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Closing the panel is what marks things as seen.
    if (!next && unread > 0) {
      start(async () => {
        await markNotificationsReadAction();
        router.refresh();
      });
    }
  };

  const button = (
    <button
      className={cn('focus-ring group flex h-8 items-center gap-2.5 rounded-md text-[13px] text-ink-2 hover:bg-ink/[0.045] hover:text-ink', rail ? 'w-8 justify-center' : 'w-full px-2')}
      aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
    >
      <span className="relative">
        <Bell className="size-4 text-ink-3 group-hover:text-ink-2" strokeWidth={1.9} />
        {rail && unread ? <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-accent ring-2 ring-canvas" /> : null}
      </span>
      {rail ? null : <span className="flex-1 text-left">Notifications</span>}
      {!rail && unread ? <span className="num rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white">{unread}</span> : null}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange} side="right" align="end" className="w-[360px] p-0" trigger={button}>
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <span className="text-[13px] font-semibold">Notifications</span>
        <span className="text-xs text-ink-3">{unread ? `${unread} unread` : 'All caught up'}</span>
      </div>
      {notifications.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-ink-3">
          Nothing yet. You will be told here when a package arrives, needs your approval, or is decided.
        </div>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto py-1">
          {notifications.map((n) => {
            const body = (
              <div className="flex gap-2.5 px-3 py-2 hover:bg-sunken/60">
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-accent')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-[13px] leading-[18px]', n.read ? 'text-ink-2' : 'font-medium text-ink')}>{n.title}</span>
                  {n.body ? <span className="block truncate text-xs text-ink-3">{n.body}</span> : null}
                  <span className="block text-[11px] text-ink-4">{formatRelative(n.createdAt)}</span>
                </span>
              </div>
            );
            return (
              <li key={n.id}>
                {n.href ? (
                  <Link href={n.href} onClick={() => onOpenChange(false)} className="block">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}
