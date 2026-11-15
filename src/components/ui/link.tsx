'use client';

import NextLink from 'next/link';
import { useState, type ComponentProps } from 'react';

/**
 * `next/link` that prefetches when someone shows intent (pointer over it,
 * keyboard focus, touch), not as soon as it scrolls into view.
 *
 * Every signed-in page is rendered per request. With viewport prefetching,
 * opening one page made about 18 extra server renders, one or two for each
 * link in the sidebar and the page, each with its own session check and
 * database queries. This is the hover pattern from Next's prefetching guide.
 * An explicit `prefetch` prop still wins.
 */
export default function Link({ prefetch, onMouseEnter, onFocus, onTouchStart, ...props }: ComponentProps<typeof NextLink>) {
  const [intent, setIntent] = useState(false);
  return (
    <NextLink
      {...props}
      prefetch={prefetch !== undefined ? prefetch : intent ? null : false}
      onMouseEnter={(e) => {
        setIntent(true);
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        setIntent(true);
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        setIntent(true);
        onTouchStart?.(e);
      }}
    />
  );
}
