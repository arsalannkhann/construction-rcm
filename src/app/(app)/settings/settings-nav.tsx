'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/settings/organization', label: 'Organisation' },
  { href: '/settings/team', label: 'Team' },
  { href: '/settings/policy', label: 'Review policy' },
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings/profile', label: 'Profile' },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Settings">
      {ITEMS.map((item) => {
        const on = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'focus-ring flex h-8 items-center rounded-md px-2 text-[13px] transition-colors',
              on ? 'bg-ink/[0.07] font-medium text-ink' : 'text-ink-2 hover:bg-ink/[0.045] hover:text-ink',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
