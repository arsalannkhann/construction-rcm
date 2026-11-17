'use client';

import { CheckCircle2, FileText, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form';
import { buildUploadForm, UploadError } from '@/lib/upload-form';
import { cn } from '@/lib/utils';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Upload a package through a portal link. The link in the address bar is the only credential. */
export function PortalUpload({ token, orgName }: { token: string; orgName: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [received, setReceived] = useState<string[] | null>(null);

  const add = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    setError(null);
    setReceived(null);
    const next = [...files];
    for (const f of Array.from(incoming)) {
      if (f.size > MAX_BYTES) {
        setError(`“${f.name}” is larger than 25 MB.`);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next.slice(0, MAX_FILES));
  };

  const submit = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = await buildUploadForm(files, {}, setProgress, (uploadId, part) => `/api/portal/${encodeURIComponent(token)}/uploads/${uploadId}/parts/${part}`);
      setProgress(null);
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/applications`, { method: 'POST', body: form });
      const json = (await res.json().catch(() => ({}))) as { received?: boolean; files?: string[]; error?: string };
      if (!res.ok || !json.received) {
        setError(json.error ?? (res.status === 413 ? 'The upload is larger than this server accepts in one go. Try fewer files at a time.' : 'The upload could not be completed. Nothing was sent.'));
        setBusy(false);
        return;
      }
      setReceived(json.files ?? files.map((f) => f.name));
      setFiles([]);
      setBusy(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof UploadError ? err.message : 'The upload did not complete. Check your connection and try again.');
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <FormError message={error} />
      {received ? (
        <div className="flex gap-2.5 rounded-lg border border-pass-line bg-pass-soft px-3.5 py-3 text-[13px] text-pass" role="status">
          <CheckCircle2 className="mt-px size-4 shrink-0" />
          <div>
            <p className="font-medium">Sent to {orgName}.</p>
            <p className="mt-0.5 text-pass/90">
              {received.join(', ')}. It is listed below as received and is read straight away; the status updates as {orgName} reviews it.
            </p>
          </div>
        </div>
      ) : null}

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
        className={cn('flex flex-col items-center rounded-lg border-2 border-dashed px-5 py-8 text-center transition-colors', dragging ? 'border-accent bg-accent-soft/50' : 'border-line-strong bg-canvas/50')}
      >
        <div className="flex size-10 items-center justify-center rounded-full bg-surface text-ink-3 shadow-card ring-1 ring-line">
          <Upload className="size-[18px]" />
        </div>
        <p className="mt-3 text-sm font-medium">Your application for payment and lien waivers</p>
        <p className="mt-0.5 text-xs text-ink-3">PDF, or photos (PNG, JPEG), up to 25 MB each. Several files make one package.</p>
        <Button className="mt-3" onClick={() => input.current?.click()} disabled={busy}>
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
        <>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {files.map((f) => (
              <li key={`${f.name}-${f.size}`} className="flex items-center gap-2.5 px-3 py-2">
                <FileText className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
                <span className="num text-xs text-ink-3">{size(f.size)}</span>
                <button
                  className="focus-ring rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-40"
                  onClick={() => setFiles((all) => all.filter((x) => x !== f))}
                  disabled={busy}
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {progress !== null ? <span className="num text-xs text-ink-3">Uploading… {Math.round(progress * 100)}%</span> : null}
            <Button variant="primary" onClick={submit} loading={busy}>
              Send {files.length === 1 ? 'this file' : `these ${files.length} files`} to {orgName}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
