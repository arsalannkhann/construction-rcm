'use client';

import { FileQuestion } from 'lucide-react';
import Link from '@/components/ui/link';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Badge, Money } from '@/components/ui/data';
import { Field, Select } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import { assignContractAction } from '../actions';
import { useWorkspace } from './workspace';

/** Shown instead of the review tabs while the application has no contract. */
export function MatchingPanel() {
  const { data, perms } = useWorkspace();
  const { app } = data;
  const { pending, run } = useAction();
  const [choice, setChoice] = useState('');
  const ranked = (app.matchCandidates ?? []).map((c) => ({ ...c, contract: data.contractCandidates.find((x) => x.id === c.contractId) })).filter((c) => c.contract);
  const assign = (contractId: string) => run(() => assignContractAction(app.id, contractId), { success: 'Matched. Checking against the contract.' });

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn">
          <FileQuestion className="size-[18px]" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Which subcontract is this for?</h2>
          <p className="mt-0.5 text-[13px] text-ink-2">The documents could not be matched to one of your subcontracts with confidence, so nothing has been verified yet. Choose the subcontract and the package will be checked against it.</p>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line px-4 py-3 text-[13px]">
        <div>
          <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">From, as stated</dt>
          <dd>{app.stated?.contractorName ?? <span className="text-ink-4">Not read</span>}</dd>
        </div>
        <div>
          <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Project, as stated</dt>
          <dd>{app.stated?.projectName ?? <span className="text-ink-4">Not read</span>}</dd>
        </div>
        <div>
          <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Contract no., as stated</dt>
          <dd>{app.stated?.contractNumber ?? <span className="text-ink-4">Not read</span>}</dd>
        </div>
        <div>
          <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Requested</dt>
          <dd>
            <Money cents={app.claimedAmount} blank="Not read" />
          </dd>
        </div>
      </dl>

      {ranked.length > 0 ? (
        <section className="mt-6">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Possible matches</h3>
          <ul className="space-y-2">
            {ranked.map((c) => (
              <li key={c.contractId} className="flex items-center gap-3 rounded-lg border border-line px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {c.contract!.subcontractorName} <span className="font-normal text-ink-3">· {c.contract!.number} {c.contract!.title}</span>
                  </p>
                  <p className="truncate text-xs text-ink-3">
                    {c.contract!.projectName} · <Money cents={c.contract!.originalAmount} />
                  </p>
                  <p className="mt-0.5 text-xs text-ink-2">{c.reasons.length ? c.reasons.join('; ') : 'Weak similarity only'}</p>
                </div>
                <Badge tone={c.score >= 0.7 ? 'accent' : 'neutral'}>{Math.round(c.score * 100)}% similar</Badge>
                {perms.review ? (
                  <Button size="sm" loading={pending} onClick={() => assign(c.contractId)}>
                    Use this
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {perms.review ? (
        <section className="mt-6">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{ranked.length > 0 ? 'Or choose another' : 'Choose the subcontract'}</h3>
          {data.contractCandidates.length === 0 ? (
            <div className="rounded-lg border border-line px-4 py-5 text-center">
              <p className="text-[13px] text-ink-2">You have not set up any subcontracts yet.</p>
              <Link href="/projects" className={buttonClass({ variant: 'primary', className: 'mt-3' })}>
                Set up a project and subcontract
              </Link>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <Field label="Subcontract" className="flex-1">
                <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="">Select…</option>
                  {data.contractCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.projectName} · {c.subcontractorName} · {c.number}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" loading={pending} disabled={!choice} onClick={() => assign(choice)}>
                Match and verify
              </Button>
            </div>
          )}
          <p className="mt-3 text-xs text-ink-3">
            Not there? <Link href="/projects" className="font-medium text-accent hover:underline">Create the subcontract</Link> first, then come back to this application.
          </p>
        </section>
      ) : (
        <p className="mt-6 text-xs text-ink-3">Someone with review access needs to match this application.</p>
      )}
    </div>
  );
}
