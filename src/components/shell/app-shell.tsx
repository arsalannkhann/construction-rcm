'use client';

import { ArrowUpFromLine, Bell, Building2, CalendarRange, Check, ChevronsUpDown, Compass, FlaskConical, Globe, History, Inbox, LayoutDashboard, LifeBuoy, ListChecks, Loader2, LogOut, Map as MapIcon, MessageSquare, Plus, Route, Send, Settings, SlidersHorizontal, Users } from 'lucide-react';
import Link from '@/components/ui/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, useTransition } from 'react';
import { toast } from 'sonner';
import { switchOrgAction } from '@/app/(auth)/actions';
import { markNotificationsReadAction } from '@/app/(app)/shell-actions';
import { openExampleAction } from '@/app/onboarding-actions';
import { BrandMark } from '@/components/brand';
import { TourProvider, useTour } from '@/components/tour/tour';
import { Avatar } from '@/components/ui/data';
import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover, Tooltip } from '@/components/ui/overlay';
import { LAST_PAGE_KEY } from '@/lib/session-markers';
import { signOut } from '@/lib/sign-out';
import { cn, formatRelative } from '@/lib/utils';
import { ROLE_LABEL } from '@/server/auth/permissions';
import type { Role, TourId } from '@/server/types';

type Org = { id: string; name: string; isDemo: boolean };
type Notice = { id: string; title: string; body: string | null; href: string | null; read: boolean; createdAt: string };

type NavItem = { href: string; label: string; icon: typeof Inbox; tour?: string; badge?: 'attention'; exportOnly?: boolean };

/**
 * The sidebar, grouped by the work rather than by the software: what is
 * billed, what it is billed against, and the record of what happened. The
 * words are the trade's own. Setup, help and settings sit at the bottom, out
 * of the way of the daily work.
 */
const NAV: Array<{ label: string | null; items: NavItem[] }> = [
  { label: null, items: [{ href: '/overview', label: 'Overview', icon: LayoutDashboard, tour: 'nav-overview' }] },
  {
    label: 'Billing',
    items: [
      { href: '/applications', label: 'Pay applications', icon: Inbox, tour: 'nav-applications', badge: 'attention' },
      { href: '/billing', label: 'Billing periods', icon: CalendarRange, tour: 'nav-billing' },
    ],
  },
  {
    label: 'Projects',
    items: [
      { href: '/projects', label: 'Projects', icon: Building2, tour: 'nav-projects' },
      { href: '/subcontractors', label: 'Subcontractors', icon: Users },
    ],
  },
  {
    label: 'Records',
    items: [
      { href: '/transfers', label: 'Exports', icon: Send, tour: 'nav-exports', exportOnly: true },
      { href: '/activity', label: 'Activity', icon: History, tour: 'nav-activity' },
    ],
  },
];

export type ShellOnboarding = {
  /** Whether the setup guide is offered in the sidebar: not once it is finished or put away. */
  guide: boolean;
  tour: { id: TourId; step: number; paused?: boolean } | null;
};

export function AppShell({
  user,
  org,
  organizations,
  attention,
  unread,
  notifications,
  canUpload,
  canExport,
  hasApplications,
  onboarding,
  children,
}: {
  user: { name: string; email: string; role: Role };
  org: Org;
  organizations: Org[];
  attention: number;
  unread: number;
  notifications: Notice[];
  canUpload: boolean;
  canExport: boolean;
  /** The organisation has at least one billing package, so there is something for the review tour to point at. */
  hasApplications: boolean;
  onboarding: ShellOnboarding;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [, start] = useTransition();
  // The review workspace needs the width, and so does a phone; the sidebar folds to a rail there.
  const narrow = useNarrowScreen();
  const rail = narrow || /^\/applications\/(?!new$)[^/]+$/.test(pathname);
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`) || (href === '/projects' && pathname.startsWith('/contracts'));

  const [leaving, setLeaving] = useState<null | 'signing-out' | 'switching'>(null);
  useRememberPage(pathname);
  useReloadWhenRestored();

  // A full page load into the other organisation, replacing this history entry, so nothing from this one stays on screen or in memory.
  const switchTo = (id: string) =>
    start(async () => {
      setLeaving('switching');
      const result = await switchOrgAction(id);
      if (!result.ok) {
        setLeaving(null);
        toast.error(result.error);
      } else window.location.replace('/overview');
    });

  const leave = () => {
    setLeaving('signing-out');
    void signOut();
  };

  const item = (href: string, label: string, Icon: typeof Inbox, badge?: number, tour?: string) => {
    const on = active(href);
    const link = (
      <Link
        key={href}
        href={href}
        data-tour={tour}
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

  const ownOrg = organizations.find((o) => !o.isDemo) ?? null;

  return (
    <TourProvider initial={onboarding.tour} env={{ isDemo: org.isDemo, hasOwnOrg: ownOrg !== null, canUpload }}>
    <div className="flex h-screen overflow-hidden">
      <aside className={cn('flex shrink-0 flex-col border-r border-line bg-canvas transition-[width] duration-150', rail ? 'w-[52px] items-center px-0 py-3' : 'w-[232px] px-3 py-3')}>
        <div className={cn('flex items-center', rail ? 'flex-col gap-2' : 'gap-1')}>
          <Tooltip content="Overview" side="right">
            <Link href="/overview" className="focus-ring flex size-8 shrink-0 items-center justify-center rounded-lg transition-transform hover:bg-ink/[0.045] active:scale-95" aria-label="Zephric, go to overview">
              <BrandMark className="size-[22px]" />
            </Link>
          </Tooltip>
        <Menu
          align="start"
          trigger={
            <button
              className={cn('focus-ring flex items-center gap-2 rounded-lg text-left hover:bg-ink/[0.045]', rail ? 'size-8 justify-center' : 'h-10 min-w-0 flex-1 px-2')}
              aria-label={`Organisation: ${org.name}. Switch organisation`}
            >
              {rail ? (
                <span className="flex size-6 items-center justify-center rounded-md border border-line bg-surface text-[11px] font-semibold text-ink-2">{org.name.trim().charAt(0).toUpperCase() || '·'}</span>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold leading-4 text-ink">{org.name}</span>
                    <span className="block text-[11px] leading-4 text-ink-3">{org.isDemo ? 'Example workspace' : ROLE_LABEL[user.role]}</span>
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
              {o.isDemo ? <span className="ml-auto pl-3 text-[11px] text-ink-3">Example</span> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => router.push('/settings/organization#demo')} icon={<FlaskConical />}>
            {organizations.some((o) => o.isDemo) ? 'About the example workspace' : 'Explore an example workspace'}
          </MenuItem>
        </Menu>
        </div>

        {canUpload ? (
          rail ? (
            <Tooltip content="Upload a billing package" side="right">
              <Link href="/applications/new" data-tour="nav-upload" className="focus-ring mt-3 flex size-8 items-center justify-center rounded-md bg-ink text-white hover:bg-ink/88" aria-label="Upload a billing package">
                <Plus className="size-4" />
              </Link>
            </Tooltip>
          ) : (
            <Link href="/applications/new" data-tour="nav-upload" className="focus-ring mt-3 flex h-8 items-center justify-center gap-1.5 rounded-md bg-ink text-[13px] font-medium text-white hover:bg-ink/88">
              <ArrowUpFromLine className="size-3.5" />
              Upload package
            </Link>
          )
        ) : null}

        <nav className={cn('mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto', rail && 'items-center')} aria-label="Main">
          {NAV.map((group, g) => {
            const items = group.items.filter((n) => !n.exportOnly || canExport);
            if (items.length === 0) return null;
            return (
              <div key={group.label ?? 'top'} className={cn('flex flex-col gap-0.5', rail && 'items-center', g > 0 && (rail ? 'mt-2 border-t border-line pt-2' : 'mt-3.5'))} role="group" aria-label={group.label ?? undefined}>
                {group.label && !rail ? <p className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-ink-4">{group.label}</p> : null}
                {items.map((n) => item(n.href, n.label, n.icon, n.badge === 'attention' ? attention : undefined, n.tour))}
              </div>
            );
          })}
        </nav>

        <div className={cn('flex shrink-0 flex-col gap-0.5 pt-2', rail && 'items-center')}>
          {onboarding.guide && !org.isDemo ? item('/get-started', 'Get started', ListChecks) : null}
          <HelpMenu rail={rail} isDemo={org.isDemo} ownOrg={ownOrg} hasDemo={organizations.some((o) => o.isDemo)} hasApplications={hasApplications} onSwitch={switchTo} />
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
            <MenuItem onSelect={() => router.push('/')} icon={<Globe />}>
              Zephric website
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={leave} icon={<LogOut />}>
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
              <span className="font-medium">Example workspace.</span> Fictitious companies and amounts, kept separate from your organisation’s records.
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

      {/* Covers the app while leaving it, so nothing stays on screen (or in a back-forward cache snapshot) after signing out or switching. */}
      {leaving ? (
        <div className="fixed inset-0 z-[100] flex animate-in items-center justify-center bg-canvas" role="status" aria-live="polite">
          <div className="flex items-center gap-2.5 text-[13px] text-ink-2">
            <Loader2 className="size-4 animate-spin text-ink-3" />
            {leaving === 'signing-out' ? 'Signing out…' : 'Switching organisation…'}
          </div>
        </div>
      ) : null}
    </div>
    </TourProvider>
  );
}

/**
 * Help: the setup guide, the tours and the example workspace, always in the
 * same place. A tour is only offered where it has something to point at: the
 * review tour needs a billing package, so an organisation without one is
 * offered the example instead.
 */
function HelpMenu({ rail, isDemo, ownOrg, hasDemo, hasApplications, onSwitch }: { rail: boolean; isDemo: boolean; ownOrg: Org | null; hasDemo: boolean; hasApplications: boolean; onSwitch: (id: string) => void }) {
  const router = useRouter();
  const { start } = useTour();
  const [, begin] = useTransition();

  const openExample = () => {
    const building = hasDemo ? undefined : toast.loading('Preparing the example workspace…', { description: 'About forty billing packages are being generated, read and checked. Up to a minute.' });
    begin(async () => {
      const result = await openExampleAction();
      if (building !== undefined) toast.dismiss(building);
      if (!result.ok) toast.error(result.error);
      else window.location.assign(result.data.next);
    });
  };

  return (
    <Menu
      align="start"
      side="top"
      trigger={
        <button
          data-tour="nav-help"
          className={cn('focus-ring group flex h-8 items-center gap-2.5 rounded-md text-[13px] text-ink-2 hover:bg-ink/[0.045] hover:text-ink', rail ? 'w-8 justify-center' : 'w-full px-2')}
          aria-label="Help and tours"
        >
          <LifeBuoy className="size-4 text-ink-3 group-hover:text-ink-2" strokeWidth={1.9} />
          {rail ? null : <span className="flex-1 text-left">Help</span>}
        </button>
      }
    >
      <MenuLabel>Learn Zephric</MenuLabel>
      {hasApplications ? (
        <MenuItem onSelect={() => start('review')} icon={<Route />}>
          Tour: how billing is reviewed
        </MenuItem>
      ) : (
        <MenuItem onSelect={openExample} icon={<Route />}>
          See a review in the example
        </MenuItem>
      )}
      <MenuItem onSelect={() => start('workspace')} icon={<MapIcon />}>
        Tour: where things are
      </MenuItem>
      {isDemo ? null : (
        <MenuItem onSelect={() => router.push('/get-started')} icon={<ListChecks />}>
          Setup guide
        </MenuItem>
      )}
      <MenuSeparator />
      {isDemo ? (
        ownOrg ? (
          <MenuItem onSelect={() => onSwitch(ownOrg.id)} icon={<Building2 />}>
            Back to {ownOrg.name}
          </MenuItem>
        ) : null
      ) : (
        <MenuItem onSelect={openExample} icon={<Compass />}>
          {hasDemo ? 'Open the example workspace' : 'Explore the example workspace'}
        </MenuItem>
      )}
      {isDemo ? null : (
        <MenuItem onSelect={() => router.push('/start')} icon={<SlidersHorizontal />}>
          What I see first
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem onSelect={() => window.open('/#partner', '_blank', 'noopener')} icon={<MessageSquare />}>
        Contact the Zephric team
      </MenuItem>
    </Menu>
  );
}

/** Page-type labels for the public website's "Resume …" link. Never record names or figures. */
function pageLabel(path: string): string | null {
  if (path === '/applications/new') return 'your upload';
  if (/^\/applications\/[^/]+/.test(path)) return 'the pay application you were reviewing';
  if (/^\/projects\/[^/]+/.test(path)) return 'the project you were viewing';
  if (/^\/contracts\/[^/]+/.test(path)) return 'the subcontract you were viewing';
  if (/^\/subcontractors\/[^/]+/.test(path)) return 'the subcontractor you were viewing';
  const top: Record<string, string> = { '/applications': 'pay applications', '/projects': 'projects', '/subcontractors': 'subcontractors', '/billing': 'billing periods', '/transfers': 'exports', '/activity': 'activity', '/settings': 'settings', '/get-started': 'the setup guide' };
  const key = Object.keys(top).find((k) => path === k || path.startsWith(`${k}/`));
  return key ? top[key] : null;
}

/** Remembers the last app page (its path only) so the website can offer to resume it. Cleared on sign-out. */
function useRememberPage(pathname: string) {
  useEffect(() => {
    const label = pageLabel(pathname);
    try {
      if (label) window.localStorage.setItem(LAST_PAGE_KEY, JSON.stringify({ path: pathname, label }));
      else if (pathname === '/overview') window.localStorage.removeItem(LAST_PAGE_KEY);
    } catch {
      // Storage unavailable: nothing to offer later.
    }
  }, [pathname]);
}

/**
 * A page brought back from the browser's back-forward cache (Back after
 * signing out or switching organisation) is a snapshot of the past: reload it,
 * so the server decides again what this browser may see.
 */
function useReloadWhenRestored() {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);
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
    <Popover open={open} onOpenChange={onOpenChange} side="right" align="end" className="w-[min(360px,calc(100vw-72px))] p-0" trigger={button}>
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

const NARROW = '(max-width: 767px)';

/** Whether the window is phone-width. False while rendering on the server, so the first paint has the full sidebar. */
function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}
