'use client';

import Link from '@/components/ui/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Note, ScheduleDifference } from '@/components/records/figures';
import { PercentInput, retainageError } from '@/components/records/percent-input';
import { filledRows, ScheduleEditor, scheduleLinesFrom, scheduleRow, scheduleRowsTotal, type ScheduleRow } from '@/components/records/schedule-editor';
import { Button, buttonClass } from '@/components/ui/button';
import { Money, Panel, PanelHeader, Stat } from '@/components/ui/data';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { parsePercentToBps } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { SubcontractorDialogButton } from '../../subcontractors/subcontractor-dialog';
import { assignContractAction } from '../../applications/actions';
import { createContractAction } from '../actions';

type Option = { id: string; label: string };

/** An application that could not be matched, whose subcontract is being set up from what it states. */
export type FromApplication = {
  id: string;
  title: string;
  contractNumber: string | null;
  subcontractorId: string | null;
  contractorName: string | null;
  projectName: string | null;
  projectMatched: boolean;
};

function prefilledSentence(from: FromApplication): string {
  const filled = [from.contractNumber ? 'contract number' : null, from.subcontractorId ? 'subcontractor' : null, from.projectMatched ? 'project' : null].filter((x): x is string => x !== null);
  if (filled.length === 0) return 'Nothing could be filled in from the package.';
  const list = filled.length === 1 ? filled[0] : `${filled.slice(0, -1).join(', ')} and ${filled.at(-1)}`;
  return `The ${list} ${filled.length === 1 ? 'was' : 'were'} filled in from what the package states; check ${filled.length === 1 ? 'it' : 'them'}.`;
}

export function ContractForm({
  projects,
  subcontractors,
  defaultProjectId,
  cancelHref,
  fromApplication = null,
}: {
  projects: Option[];
  subcontractors: Option[];
  defaultProjectId: string;
  cancelHref: string;
  fromApplication?: FromApplication | null;
}) {
  const router = useRouter();
  const { pending, run } = useAction();
  const [created, setCreated] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [subcontractorOptions, setSubcontractorOptions] = useState(subcontractors);
  const [subcontractorId, setSubcontractorId] = useState(fromApplication ? (fromApplication.subcontractorId ?? '') : subcontractors.length === 1 ? subcontractors[0]!.id : '');
  const [number, setNumber] = useState(fromApplication?.contractNumber ?? '');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [retainageWork, setRetainageWork] = useState('10');
  const [retainageStored, setRetainageStored] = useState('10');
  const [executedOn, setExecutedOn] = useState('');
  const [rows, setRows] = useState<ScheduleRow[]>(() => [scheduleRow({ itemNo: '1' }), scheduleRow({ itemNo: '2' }), scheduleRow({ itemNo: '3' })]);

  const workError = retainageError(retainageWork);
  const storedError = retainageError(retainageStored);
  const complete = !!projectId && !!subcontractorId && !!number.trim() && !!title.trim() && amount !== null && !workError && !storedError;
  const busy = pending || created;
  const hasSchedule = filledRows(rows).length > 0;
  const scheduleTotal = scheduleRowsTotal(rows);

  const submit = () => {
    const workBps = parsePercentToBps(retainageWork);
    const storedBps = parsePercentToBps(retainageStored);
    if (!complete || amount === null || workBps === null || storedBps === null) return;
    const schedule = scheduleLinesFrom(rows);
    if (!schedule.ok) {
      toast.error(schedule.error);
      return;
    }
    run(
      () =>
        createContractAction({
          projectId,
          subcontractorId,
          number,
          title,
          originalAmount: amount,
          retainageWorkBps: workBps,
          retainageStoredBps: storedBps,
          executedOn: executedOn || null,
          schedule: schedule.lines,
        }),
      {
        refresh: false,
        success: 'Subcontract created',
        onSuccess: ({ id }) => {
          setCreated(true);
          if (!fromApplication) {
            router.push(`/contracts/${id}`);
            return;
          }
          // Started from an application that could not be matched: match it to the new subcontract.
          void assignContractAction(fromApplication.id, id)
            .then((matched) => {
              if (matched.ok) {
                toast.success('Matched. Checking against the contract.');
                router.push(`/applications/${fromApplication.id}`);
              } else {
                toast.error(`The application was not matched: ${matched.error}`);
                router.push(`/contracts/${id}`);
              }
            })
            .catch(() => router.push(`/contracts/${id}`));
        },
      },
    );
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {fromApplication ? (
        <Note>
          <p className="font-medium">Setting up the subcontract for {fromApplication.title}</p>
          <p className="mt-0.5">
            {prefilledSentence(fromApplication)}
            {fromApplication.projectName && !fromApplication.projectMatched ? (
              <>
                {' '}
                The package names the project “{fromApplication.projectName}”, which is not one of your projects: choose it below, or{' '}
                <Link href={`/projects/new?from=${fromApplication.id}`} className="font-medium text-accent hover:underline">
                  create it
                </Link>
                .
              </>
            ) : null}{' '}
            Enter the amount, retainage and schedule from the subcontract itself, not from the pay application, so the application is checked against an independent record. When you create the subcontract, the application is matched to it and
            checked.
          </p>
        </Note>
      ) : null}
      <Panel>
        <PanelHeader title="Contract" description="Who the subcontract is with, and the terms every application on it is checked against." />
        <div className="grid grid-cols-2 gap-4 p-4 lg:grid-cols-4">
          <Field label="Project" className="col-span-2">
            <Select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="" disabled>
                Select a project
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="col-span-2">
            <Field label="Subcontractor">
              <Select required value={subcontractorId} onChange={(e) => setSubcontractorId(e.target.value)}>
                <option value="" disabled>
                  {subcontractorOptions.length ? 'Select a subcontractor' : 'None yet: add one below'}
                </option>
                {subcontractorOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="mt-1 text-xs text-ink-3">
              {subcontractorOptions.length ? 'Not in the list? ' : ''}
              <SubcontractorDialogButton
                mode="create"
                asLink={fromApplication?.contractorName && !fromApplication.subcontractorId ? `Add ${fromApplication.contractorName}` : 'Add a subcontractor'}
                initialName={fromApplication?.subcontractorId ? undefined : (fromApplication?.contractorName ?? undefined)}
                onCreated={(created) => {
                  setSubcontractorOptions((list) => [...list, created].sort((a, b) => a.label.localeCompare(b.label)));
                  setSubcontractorId(created.id);
                }}
              />
              {subcontractorOptions.length ? '' : ' without leaving this page.'}
            </p>
          </div>
          <Field label="Contract number">
            <Input required value={number} onChange={(e) => setNumber(e.target.value)} placeholder="SC-2301-16" />
          </Field>
          <Field label="Scope / title" className="lg:col-span-3">
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Electrical" />
          </Field>
          <Field label="Original contract amount">
            <MoneyInput required value={amount} onChange={setAmount} placeholder="0.00" />
          </Field>
          <Field label="Retainage on completed work" error={workError}>
            <PercentInput value={retainageWork} onChange={(e) => setRetainageWork(e.target.value)} aria-invalid={!!workError} />
          </Field>
          <Field label="Retainage on stored materials" error={storedError}>
            <PercentInput value={retainageStored} onChange={(e) => setRetainageStored(e.target.value)} aria-invalid={!!storedError} />
          </Field>
          <Field label="Contract date" optional>
            <Input type="date" value={executedOn} onChange={(e) => setExecutedOn(e.target.value)} />
          </Field>
          <p className="col-span-full -mt-1 text-xs text-ink-3">
            Retainage is the share of the work billed that is withheld from each payment until release. Applications are checked against these two rates, so enter them as the subcontract states them.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Schedule of values"
          description="Optional for now. You can leave it empty and adopt the schedule from the first pay application during review; until a schedule is on file, applications cannot be checked line by line."
        />
        <div className="space-y-3 p-4">
          <dl className="flex flex-wrap gap-x-10 gap-y-2">
            <Stat label="Schedule total">
              <Money cents={scheduleTotal} className="font-semibold" />
            </Stat>
            <Stat label="Contract amount">
              <Money cents={amount} />
            </Stat>
          </dl>
          {hasSchedule && amount !== null ? <ScheduleDifference scheduleTotal={scheduleTotal} contractAmount={amount} saving /> : null}
          <ScheduleEditor rows={rows} onChange={setRows} disabled={busy} />
        </div>
      </Panel>

      <div className="flex items-center justify-end gap-2">
        <Link href={cancelHref} className={buttonClass({ variant: 'ghost' })}>
          Cancel
        </Link>
        <Button type="submit" variant="primary" loading={busy} disabled={!complete}>
          Create subcontract
        </Button>
      </div>
    </form>
  );
}
