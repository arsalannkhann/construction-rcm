'use client';

import { ArrowRight, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Brand } from '@/components/brand';
import { cn } from '@/lib/utils';
import { useSignedIn } from './session-hint';

const LINKS = [
  { href: '/sample', label: 'Sample workflow' },
  { href: '#workflow', label: 'How it works' },
  { href: '#teams', label: 'Who it’s for' },
  { href: '#status', label: 'Where it stands' },
];
/** In the phone menu only: the header has no room for it at laptop widths, and the page ends with it. */
const MORE = [{ href: '#faq', label: 'FAQ' }];

/**
 * The public website's header. The logo always leads to the homepage. A
 * visitor with a session sees "Continue to dashboard" in place of "Sign in";
 * being signed in never sends anyone away from this page.
 */
export function SiteNav() {
  const signedIn = useSignedIn();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    const onResize = () => window.innerWidth >= 1000 && setOpen(false);
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300',
        scrolled || open ? 'border-b border-line/80 bg-canvas/85 backdrop-blur-xl backdrop-saturate-150' : 'border-b border-transparent',
      )}
    >
      <nav className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-5 sm:px-8" aria-label="Main">
        <Link href="/" onClick={close} className="focus-ring -m-1.5 shrink-0 rounded-lg p-1.5 transition-opacity hover:opacity-80" aria-label="Zephric home">
          <Brand className="h-[26px]" priority />
        </Link>

        <ul className="ml-4 hidden items-center gap-0.5 min-[1000px]:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} prefetch={false} className="focus-ring whitespace-nowrap rounded-md px-3 py-2 text-[14px] text-ink-2 transition-colors hover:text-ink">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="ml-auto hidden items-center gap-2 min-[1000px]:flex">
          {signedIn ? (
            <Link href="/overview" className="focus-ring group inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-[14px] font-medium text-white transition-colors hover:bg-ink/85">
              Continue to dashboard
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ) : (
            <>
              <Link href="/login" className="focus-ring whitespace-nowrap rounded-md px-3 py-2 text-[14px] font-medium text-ink-2 transition-colors hover:text-ink">
                Sign in
              </Link>
              <a href="#partner" className="focus-ring inline-flex h-9 items-center whitespace-nowrap rounded-full bg-ink px-4 text-[14px] font-medium text-white transition-colors hover:bg-ink/85">
                Become a design partner
              </a>
            </>
          )}
        </div>

        <button
          ref={menuButton}
          type="button"
          className="focus-ring -mr-2 ml-auto flex size-10 items-center justify-center rounded-lg text-ink min-[1000px]:hidden"
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </nav>

      <div
        id="site-menu"
        hidden={!open}
        className="h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line/70 bg-canvas px-5 pb-10 pt-4 min-[1000px]:hidden"
      >
        <ul className="divide-y divide-line/80">
          {[...LINKS, ...MORE].map((l, i) => (
            <li key={l.href} className="animate-rise" style={{ animationDelay: `${i * 35}ms` }}>
              <Link href={l.href} prefetch={false} onClick={close} className="flex items-center justify-between py-4 text-[17px] font-medium text-ink">
                {l.label}
                <ArrowRight className="size-4 text-ink-4" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-8 grid gap-3">
          {signedIn ? (
            <Link href="/overview" onClick={close} className="flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-medium text-white">
              Continue to dashboard <ArrowRight className="size-4" />
            </Link>
          ) : (
            <>
              <Link href="/sample" onClick={close} className="flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-medium text-white">
                Explore a sample workflow <ArrowRight className="size-4" />
              </Link>
              <a href="#partner" onClick={close} className="flex h-12 items-center justify-center rounded-full border border-line-strong bg-surface text-[15px] font-medium text-ink">
                Become a design partner
              </a>
              <Link href="/login" onClick={close} className="flex h-12 items-center justify-center rounded-full border border-line-strong bg-surface text-[15px] font-medium text-ink">
                Sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
