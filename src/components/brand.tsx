import Image from 'next/image';
import { cn } from '@/lib/utils';
import logo from '@/assets/zephric-logo.png';

/**
 * The Zephric "Z", drawn as SVG so it stays sharp at every size. Two blue
 * bars and the aqua diagonal between them; the gradients are the logo's own.
 */
export function BrandMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-6 shrink-0', className)} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id="zephric-mark-bars" x2="1" y2="1">
          <stop stopColor="#0759ff" />
          <stop offset="1" stopColor="#0636bd" />
        </linearGradient>
        <linearGradient id="zephric-mark-diagonal" x2=".8" y2="1">
          <stop stopColor="#00e1ca" />
          <stop offset="1" stopColor="#0095fc" />
        </linearGradient>
      </defs>
      <path fill="url(#zephric-mark-bars)" d="M18 8h36L38 24H5zM25 40h34L44 56H10z" />
      <path fill="url(#zephric-mark-diagonal)" d="M51 8c9 0 12 10 4 17L18 55c-8 6-16-4-9-11L46 10z" />
    </svg>
  );
}

/** The full Zephric logo: the "Z" and the wordmark. */
export function Brand({ className, priority }: { className?: string; priority?: boolean }) {
  return <Image src={logo} alt="Zephric" unoptimized priority={priority} className={cn('h-7 w-auto', className)} />;
}
