'use client';

import { CircleCheck, Download, FolderOpen, Loader2, TriangleAlert } from 'lucide-react';
import Link from '@/components/ui/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice } from '@/components/settings/notice';
import { Button, buttonClass } from '@/components/ui/button';
import { Badge, EmptyState } from '@/components/ui/data';
import { Dialog } from '@/components/ui/overlay';
import { pluralize } from '@/lib/utils';
import type { ProcoreImportResult, ProcoreProjectListing } from '@/server/integrations/procore';
import { importProjectAction, listProcoreProjectsAction } from './actions';

const NO_ANSWER = 'The request could not be completed. Check your connection and try again.';

type Outcome = { project: ProcoreProjectListing; result: ProcoreImportResult };

/**
 * Lists the projects the connected Procore login can see and imports one at a
 * time. After an import the dialog shows exactly what was created, what was
 * updated and every item that was left out, with the reason.
 */
export function ImportDialogButton({ companyName }: { companyName: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProcoreProjectListing[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<{ project: ProcoreProjectListing; message: string } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listProcoreProjectsAction();
      if (res.ok) setProjects(res.data);
      else setLoadError(res.error);
    } catch {
      setLoadError(NO_ANSWER);
    } finally {
      setLoading(false);
    }
  };

  const runImport = async (project: ProcoreProjectListing) => {
    if (importing) return;
    setImporting(project.id);
    setImportError(null);
    try {
      const res = await importProjectAction(project.id);
      if (res.ok) {
        setOutcome({ project, result: res.data });
        setProjects((list) => list?.map((p) => (p.id === project.id ? { ...p, imported: true } : p)) ?? null);
      } else {
        setImportError({ project, message: res.error });
      }
    } catch {
      setImportError({ project, message: NO_ANSWER });
    } finally {
      setImporting(null);
      // Records may have been created even if the import stopped part-way; show the current state behind the dialog.
      router.refresh();
    }
  };

  const company = companyName ?? 'the connected Procore company';

  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          setProjects(null);
          setOutcome(null);
          setImportError(null);
          setOpen(true);
          void load();
        }}
      >
        <Download className="size-3.5" strokeWidth={1.9} />
        Import from Procore
      </Button>
      <Dialog
        open={open}
        // An import in flight keeps running on the server; keep the dialog open so its result is seen.
        onOpenChange={(next) => {
          if (!importing) setOpen(next);
        }}
        size="lg"
        title={outcome ? `Imported ${outcome.project.name}` : 'Import from Procore'}
        description={
          outcome
            ? undefined
            : `Choose a project in ${company}. Its vendors, its Approved and Complete subcontracts, their schedules of values and their change orders are brought in. Importing again updates what changed and never deletes anything here.`
        }
        footer={
          outcome ? (
            <>
              <Button variant="ghost" onClick={() => setOutcome(null)}>
                Import another project
              </Button>
              <Link href={`/projects/${outcome.result.projectId}`} className={buttonClass({ variant: 'primary' })}>
                Open the project
              </Link>
            </>
          ) : (
            <Button variant="ghost" disabled={!!importing} onClick={() => setOpen(false)}>
              Close
            </Button>
          )
        }
      >
        {outcome ? (
          <ImportSummary result={outcome.result} />
        ) : loading ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-ink-3" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading projects from Procore…
          </div>
        ) : loadError ? (
          <div className="space-y-3">
            <Notice tone="block" icon={<TriangleAlert strokeWidth={1.9} />}>
              The project list could not be loaded. {loadError}
            </Notice>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        ) : projects && projects.length === 0 ? (
          <EmptyState
            icon={<FolderOpen />}
            title="No projects to import"
            description={`The Procore user who connected cannot see any projects in ${company}. Projects appear here once that user is added to them in Procore.`}
            action={<Button onClick={() => void load()}>Check again</Button>}
          />
        ) : projects ? (
          <div className="space-y-3">
            {importError ? (
              <Notice tone="block" icon={<TriangleAlert strokeWidth={1.9} />}>
                Importing {importError.project.name} stopped before it finished. {importError.message} Anything already brought in was kept; importing again continues without duplicating it.
              </Notice>
            ) : null}
            {importing ? (
              <p className="text-xs text-ink-3" role="status">
                Importing. Each subcontract takes a few requests to Procore, so a large project can take a minute.
              </p>
            ) : null}
            <ul className="overflow-hidden rounded-md border border-line">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[13px] font-medium text-ink">{p.name}</span>
                      {p.imported ? <Badge tone="pass">Imported</Badge> : null}
                      {p.active ? null : <Badge tone="muted">Inactive in Procore</Badge>}
                    </div>
                    <div className="text-xs text-ink-3">{p.number ? `Project ${p.number}` : 'No project number'}</div>
                  </div>
                  <Button variant={p.imported ? 'secondary' : 'primary'} size="sm" loading={importing === p.id} disabled={!!importing && importing !== p.id} onClick={() => void runImport(p)}>
                    {p.imported ? 'Re-import' : 'Import'}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function ImportSummary({ result }: { result: ProcoreImportResult }) {
  const { created, updated, skipped } = result;
  const createdAny = created.subcontractors + created.contracts + created.scheduleLines + created.changeOrders > 0;
  const rows: Array<[string, string]> = [
    ['Subcontractors created', String(created.subcontractors)],
    ['Subcontracts created', String(created.contracts)],
    ['Schedule lines created', String(created.scheduleLines)],
    ['Change orders created', String(created.changeOrders)],
    ['Subcontracts updated', String(updated.contracts)],
  ];

  return (
    <div className="space-y-4">
      <Notice tone="pass" icon={<CircleCheck strokeWidth={1.9} />}>
        {createdAny || updated.contracts > 0 ? 'The import finished.' : 'The import finished. Everything in Procore was already here, so nothing was created or changed.'}
      </Notice>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 border-b border-line py-1">
            <dt className="text-xs text-ink-3">{label}</dt>
            <dd className="num text-[13px] font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="text-[13px] font-semibold text-ink">{skipped.length === 0 ? 'Nothing was skipped' : `${pluralize(skipped.length, 'item')} skipped or needing attention`}</h3>
        {skipped.length === 0 ? (
          <p className="mt-1 text-xs text-ink-3">Every vendor, Approved or Complete subcontract, schedule line and change order on the project was brought in.</p>
        ) : (
          <ul className="mt-2 overflow-hidden rounded-md border border-warn-line">
            {skipped.map((s, i) => (
              <li key={`${s.what}-${i}`} className="border-b border-warn-line bg-warn-soft/50 px-3 py-2 last:border-b-0">
                <div className="text-[13px] font-medium text-ink">{s.what}</div>
                <div className="text-xs text-ink-2">{s.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
