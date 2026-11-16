'use client';

import { useEffect } from 'react';

/**
 * Fades sections in as they scroll into view. Content is visible without
 * script, and the CSS skips the motion for people who ask for reduced motion
 * (src/app/globals.css). Mounted once per page.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const root = document.documentElement;
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!('IntersectionObserver' in window) || items.length === 0) return;
    root.classList.add('js-reveal');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    for (const el of items) observer.observe(el);
    return () => {
      observer.disconnect();
      root.classList.remove('js-reveal');
    };
  }, []);
  return null;
}
