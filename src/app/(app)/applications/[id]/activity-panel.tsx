'use client';

import { Bot, ChevronRight, Mail, MailWarning, MailX } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Avatar, Badge } from '@/components/ui/data';
import { Textarea } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import { cn, formatDateTime } from '@/lib/utils';
import type { ReviewData } from '@/server/services/queries';
import { addCommentAction } from '../actions';
import { useWorkspace } from './workspace';

type Message = ReviewData['messages'][number];

const DELIVERY: Record<string, { label: string; tone: 'pass' | 'neutral' | 'block'; Icon: typeof Mail }> = {
  sent: { label: 'Sent', tone: 'pass', Icon: Mail },
  not_sent: { label: 'Drafted, not sent', tone: 'neutral', Icon: MailWarning },
  failed: { label: 'Failed to send', tone: 'block', Icon: MailX },
};

export function ActivityPanel() {
  const { data, perms } = useWorkspace();
  const [body, setBody] = useState('');
  const { pending, run } = useAction();

  return (
    <div className="space-y-6 px-5 py-4">
      {data.messages.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Messages to the subcontractor</h2>
          <ul className="space-y-2">
            {data.messages.map((m) => (
              <li key={m.id}>
                <MessageRow message={m} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Internal notes</h2>
        {data.comments.length > 0 ? (
          <ul className="mb-3 space-y-3">
            {data.comments.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <Avatar name={c.userName} />
                <div className="min-w-0">
                  <p className="text-xs">
                    <span className="font-medium text-ink">{c.userName}</span> <span className="text-ink-3">{formatDateTime(c.createdAt)}</span>
                  </p>
                  <p className="whitespace-pre-wrap break-words text-[13px] text-ink-2">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {perms.comment ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!body.trim()) return;
              run(() => addCommentAction(data.app.id, body), { onSuccess: () => setBody('') });
            }}
          >
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note for your team. Not visible to the subcontractor." className="min-h-16" />
            <div className="mt-1.5 flex justify-end">
              <Button size="sm" type="submit" variant="primary" loading={pending} disabled={!body.trim()}>
                Add note
              </Button>
            </div>
          </form>
        ) : data.comments.length === 0 ? (
          <p className="text-xs text-ink-3">No notes.</p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">History</h2>
        <ol className="relative ml-1.5 space-y-0 border-l border-line">
          {data.timeline.map((e) => (
            <li key={e.id} className="relative pb-3.5 pl-5 last:pb-0">
              <span className={cn('absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-surface', e.actorType === 'system' ? 'bg-ink-4' : e.action.includes('approved') ? 'bg-pass' : e.action.includes('rejected') || e.action.includes('overridden') || e.action.includes('failed') ? 'bg-block' : 'bg-accent')} />
              <p className="text-[13px] leading-5 text-ink">{e.summary}</p>
              <p className="flex items-center gap-1 text-[11px] text-ink-3">
                {e.actorType === 'system' ? <Bot className="size-3" /> : null}
                {e.actorName} · {formatDateTime(e.createdAt)}
              </p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] text-ink-4">Every entry is part of the organisation’s tamper-evident audit trail and cannot be edited.</p>
      </section>
    </div>
  );
}

function MessageRow({ message: m }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const d = DELIVERY[m.status] ?? DELIVERY.not_sent!;
  return (
    <div className="rounded-lg border border-line">
      <button className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight className={cn('size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{m.subject}</span>
          <span className="block text-[11px] text-ink-3">
            To {m.toEmail} · {formatDateTime(m.createdAt)}
          </span>
        </span>
        <Badge tone={d.tone}>
          <d.Icon className="size-3" /> {d.label}
        </Badge>
      </button>
      {open ? (
        <div className="border-t border-line px-3 py-2.5">
          {m.status !== 'sent' && m.error ? <p className="mb-2 text-xs text-ink-2">{m.error} Copy the text below into your own email to send it.</p> : null}
          <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-[18px] text-ink-2">{m.body}</pre>
        </div>
      ) : null}
    </div>
  );
}
