import Image from 'next/image';
import { cn } from '@/lib/utils';
import logo from '@/assets/zephric-logo.png';
import mark from '@/assets/zephric-mark.png';

/** The Zephric "Z" on its own, for small spaces such as the sidebar. */
export function BrandMark({ className }: { className?: string }) {
  return <Image src={mark} alt="" aria-hidden unoptimized className={cn('size-6 object-contain', className)} />;
}

/** The full Zephric logo: the "Z" and the wordmark. */
export function Brand({ className }: { className?: string }) {
  return <Image src={logo} alt="Zephric" unoptimized className={cn('h-7 w-auto', className)} />;
}
