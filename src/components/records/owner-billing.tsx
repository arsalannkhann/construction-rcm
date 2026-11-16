import { AlertTriangle, Info, OctagonX } from 'lucide-react';
import { Badge } from '@/components/ui/data';
import { cn } from '@/lib/utils';
import { OWNER_APP_STATUS_LABEL, type OwnerAppStatus, type OwnerCheck } from '@/server/types';

const STATUS_TONE: Record<OwnerAppStatus, 'neutral' | 'accent' | 'pass'> = { draft: 'neutral', submitted: 'accent', certified: 'pass' };

export function OwnerStatusBadge({ status, className }: { status: OwnerAppStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot className={className}>
      {OWNER_APP_STATUS_LABEL[status]}
    </Badge>
  );
}

const CHECK_STYLE = {
  blocking: { icon: OctagonX, tone: 'text-block' },
  warning: { icon: AlertTriangle, tone: 'text-warn' },
  info: { icon: Info, tone: 'text-ink-3' },
} as const;

/** The checks on an owner application, most serious first. */
export function OwnerCheckList({ checks, className }: { checks: OwnerCheck[]; className?: string }) {
  return (
    <ul className={cn('divide-y divide-line', className)}>
      {checks.map((c, i) => {
        const { icon: Icon, tone } = CHECK_STYLE[c.severity];
        return (
          <li key={`${c.code}-${c.primeLineId ?? i}`} className="flex gap-3 px-4 py-3">
            <Icon className={cn('mt-0.5 size-4 shrink-0', tone)} aria-hidden />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">
                <span className="sr-only">{c.severity === 'blocking' ? 'Blocking: ' : c.severity === 'warning' ? 'Warning: ' : 'Note: '}</span>
                {c.title}
              </p>
              <p className="text-[13px] text-ink-2">{c.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
