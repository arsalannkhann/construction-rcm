'use client';

import { Check } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const TEAMS = [
  {
    key: 'gc',
    label: 'General contractors',
    title: 'Every pay application checked before anyone reviews it.',
    body: 'Project teams upload pay applications as they arrive. Zephric reads each one, matches it to the subcontract and checks it against the contract, approved change orders and the last application, so reviewers start from findings instead of a blank spreadsheet.',
    points: ['One queue for what needs attention, by project and subcontractor', 'Contract value, billed to date and retainage held for each subcontract', 'Each month, who has billed and who is missing'],
  },
  {
    key: 'sub',
    label: 'Subcontractors',
    title: 'Fewer rejected applications, and clear reasons when one is held.',
    body: 'Subcontractors keep sending the PDFs they send today. When something does not reconcile, the request that comes back says exactly which line and which figure, and what would resolve it, instead of a vague “please resubmit”.',
    points: ['No account or password to create: a private link is enough', 'Specific, line-level correction requests', 'They can see what was received and what was approved'],
  },
  {
    key: 'finance',
    label: 'Finance & controllers',
    title: 'Approvals with rules, evidence and a complete record.',
    body: 'Blocking findings stop an approval outright. Warnings need a reviewer to acknowledge them with a reason. Every figure is recomputed at the moment of approval, and every decision is kept in the activity history.',
    points: ['Role-based permissions for review, approval and export', 'Retainage tracked per subcontract', 'Approval records as PDF, CSV or JSON for your accounting system'],
  },
] as const;

export function TeamsTabs() {
  const [active, setActive] = useState(0);
  const base = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (active + (e.key === 'ArrowRight' ? 1 : TEAMS.length - 1)) % TEAMS.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const team = TEAMS[active];
  return (
    <div>
      <div role="tablist" aria-label="Teams" onKeyDown={onKey} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1">
        {TEAMS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.key}`}
            aria-controls={`${base}-panel`}
            aria-selected={active === i}
            tabIndex={active === i ? 0 : -1}
            onClick={() => setActive(i)}
            className={cn(
              'focus-ring shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[13.5px] font-medium transition-colors',
              active === i ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${team.key}`} key={team.key} className="mt-8 grid animate-rise gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-14">
        <div>
          <h3 className="text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-ink sm:text-[28px]">{team.title}</h3>
          <p className="mt-4 text-[15.5px] leading-[1.65] text-ink-2">{team.body}</p>
        </div>
        <ul className="space-y-3 self-center">
          {team.points.map((p) => (
            <li key={p} className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-[14.5px] text-ink">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-aqua-soft text-aqua-ink">
                <Check className="size-3" strokeWidth={3} />
              </span>
              {p}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
