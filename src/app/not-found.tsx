import { AuthFrame } from '@/components/auth/auth-frame';
import { buttonClass } from '@/components/ui/button';
import Link from '@/components/ui/link';

export const metadata = { title: 'Page not found' };

/** Any address that is not a page: says so, and offers a way back. */
export default function NotFound() {
  return (
    <AuthFrame>
      <p className="num font-mono text-[12px] text-ink-4">404</p>
      <h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.025em]">This page does not exist</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">The link may be mistyped, the page may have moved, or it may belong to another organisation. Nothing has been changed.</p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link href="/overview" className={buttonClass({ variant: 'primary', size: 'lg' })}>
          Go to the overview
        </Link>
        <Link href="/" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
          Zephric home
        </Link>
      </div>
    </AuthFrame>
  );
}
