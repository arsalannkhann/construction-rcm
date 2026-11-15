'use client';

import { Download, FileText, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/data';
import { Field, FormError, Select } from '@/components/ui/form';
import { buildUploadForm, UploadError } from '@/lib/upload-form';
import { cn } from '@/lib/utils';

type ContractOption = { id: string; label: string; group: string };
type Sample = { key: string; title: string; description: string };

const MAX_BYTES = 25 * 1024 * 1024;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function UploadForm({ contracts, preselected, aiConfigured, samples }: { contracts: ContractOption[]; preselected: string | null; aiConfigured: boolean; samples: Sample[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [contractId, setContractId] = useState(preselected && contracts.some((c) => c.id === preselected) ? preselected : '');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const add = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    setError(null);
    const next = [...files];
    for (const f of Array.from(incoming)) {
      if (f.size > MAX_BYTES) {
        setError(`“${f.name}” is larger than 25 MB.`);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next.slice(0, 20));
  };

  const submit = async () => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = await buildUploadForm(files, contractId ? { contractId } : {}, setProgress);
      setProgress(null);
      const res = await fetch('/api/applications', { method: 'POST', body: form });
      const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !json.id) {
        setError(json.error ?? (res.status === 413 ? 'The upload is larger than this server accepts in one go. Try fewer files at a time.' : 'The upload could not be completed. Nothing was saved.'));
        setBusy(false);
        return;
      }
      router.push(`/applications/${json.id}`);
    } catch (err) {
      setError(err instanceof UploadError ? err.message : 'The upload did not complete. Check your connection and try again.');
      setProgress(null);
      setBusy(false);
    }
  };

  const groups = [...new Set(contracts.map((c) => c.group))];

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Panel className="p-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(e.dataTransfer.files);
          }}
          className={cn('flex flex-col items-center rounded-lg border-2 border-dashed px-6 py-9 text-center transition-colors', dragging ? 'border-accent bg-accent-soft/50' : 'border-line-strong bg-canvas/50')}
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-surface text-ink-3 shadow-card ring-1 ring-line">
            <Upload className="size-[18px]" />
          </div>
          <p className="mt-3 text-sm font-medium">Drop the documents here</p>
          <p className="mt-0.5 text-xs text-ink-3">PDF, PNG or JPEG, up to 25 MB each</p>
          <Button className="mt-3" onClick={() => input.current?.click()}>
            Choose files
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept="application/pdf,image/png,image/jpeg,image/webp"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {files.length > 0 ? (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {files.map((f) => (
              <li key={`${f.name}-${f.size}`} className="flex items-center gap-2.5 px-3 py-2">
                <FileText className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
                <span className="num text-xs text-ink-3">{size(f.size)}</span>
                <button className="focus-ring rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink" onClick={() => setFiles((all) => all.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel className="p-4">
        <Field
          label="Subcontract"
          hint={
            contracts.length === 0
              ? 'You have no subcontracts set up yet. The package will be stored and read, and you can match it once the subcontract exists.'
              : 'Leave this on automatic and the package is matched from the subcontractor, project and contract number printed on it. If it cannot be matched with confidence you will be asked.'
          }
        >
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)} disabled={contracts.length === 0}>
            <option value="">Match automatically from the documents</option>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {contracts
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      </Panel>

      <div className="flex items-center justify-between gap-4">
        <p className="max-w-md text-xs text-ink-3">
          {aiConfigured
            ? 'Documents are read with AI and cross-checked against their text layer. Originals are stored unchanged.'
            : 'AI reading is not configured on this deployment. Digitally produced PDFs are read by the rule-based parser; scans and photos are stored and have to be keyed by hand.'}
        </p>
        <Button variant="primary" size="lg" loading={busy} disabled={files.length === 0} onClick={submit}>
          {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Upload and process'}
        </Button>
      </div>

      {samples.length > 0 ? (
        <Panel className="p-4">
          <h2 className="text-[13px] font-semibold">Sample packages for this demo workspace</h2>
          <p className="mt-0.5 text-xs text-ink-3">Realistic PDFs for the demo subcontracts. Download one, then upload it above to watch it being read and checked.</p>
          <ul className="mt-3 space-y-2">
            {samples.map((s) => (
              <li key={s.key} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{s.title}</p>
                  <p className="text-xs text-ink-3">{s.description}</p>
                </div>
                <a href={`/api/demo/samples/${s.key}`} download className="focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium hover:bg-sunken/70">
                  <Download className="size-3.5" />
                  Download PDF
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
