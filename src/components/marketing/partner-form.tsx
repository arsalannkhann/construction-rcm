'use client';

import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { LegalLink } from './legal';

const COUNTRIES = ['United States', 'India', 'United Kingdom', 'Canada', 'Australia', 'United Arab Emirates', 'Other'];
const ROLES = ['CFO / Finance leader', 'Controller', 'Finance / Accounting', 'Owner / Founder', 'Project management', 'Other'];

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; reference: string } | { kind: 'error'; message: string };

const field =
  'block w-full rounded-lg border border-line-strong bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-4 transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/12 aria-[invalid=true]:border-block';
const label = 'mb-1.5 block text-[13px] font-medium text-ink-2';

/** The design partner inquiry. Posts to the same endpoint, with the same rules, as before (src/server/services/inquiries.ts). */
export function PartnerForm() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const status = useRef<HTMLElement | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const body = {
      name: String(data.get('name') ?? ''),
      email: String(data.get('email') ?? ''),
      company: String(data.get('company') ?? ''),
      country: String(data.get('country') ?? ''),
      role: String(data.get('role') ?? ''),
      challenge: String(data.get('challenge') ?? ''),
      consent: data.get('consent') === 'on',
      website: String(data.get('website') ?? ''),
    };
    setState({ kind: 'sending' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('/api/inquiries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as { reference?: string; error?: string };
      if (res.ok && json.reference) {
        setState({ kind: 'sent', reference: json.reference });
        form.reset();
      } else {
        setState({ kind: 'error', message: json.error ?? 'We could not send your inquiry. Please try again.' });
      }
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof DOMException && err.name === 'AbortError' ? 'This is taking too long. Check your connection and try again.' : 'We could not reach Zephric. Check your connection and try again.',
      });
    } finally {
      window.clearTimeout(timer);
      requestAnimationFrame(() => status.current?.focus());
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className="flex min-h-[420px] animate-rise flex-col items-start justify-center rounded-2xl border border-line bg-surface p-8 shadow-float">
        <span className="flex size-11 items-center justify-center rounded-full bg-aqua-soft text-aqua-ink">
          <CheckCircle2 className="size-6" />
        </span>
        <h3
          ref={(el) => {
            status.current = el;
          }}
          tabIndex={-1} className="mt-5 text-[22px] font-semibold tracking-[-0.015em] text-ink outline-none">
          Thank you. We have your inquiry.
        </h3>
        <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-ink-2">
          The founders read every inquiry and will reply by email. Your reference is <span className="num font-semibold text-ink">{state.reference}</span>.
        </p>
        <button type="button" onClick={() => setState({ kind: 'idle' })} className="focus-ring mt-6 rounded-md text-[14px] font-medium text-accent hover:text-accent-ink">
          Send another inquiry
        </button>
      </div>
    );
  }

  const sending = state.kind === 'sending';
  return (
    <form onSubmit={onSubmit} className="relative rounded-2xl border border-line bg-surface p-6 shadow-float sm:p-8" aria-describedby="partner-status">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pf-name" className={label}>Name</label>
          <input id="pf-name" name="name" required maxLength={120} autoComplete="name" className={cn(field, 'h-11')} />
        </div>
        <div>
          <label htmlFor="pf-email" className={label}>Work email</label>
          <input id="pf-email" name="email" type="email" required maxLength={254} autoComplete="email" className={cn(field, 'h-11')} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pf-company" className={label}>Company</label>
          <input id="pf-company" name="company" required maxLength={160} autoComplete="organization" className={cn(field, 'h-11')} />
        </div>
        <div>
          <label htmlFor="pf-country" className={label}>Country</label>
          <select id="pf-country" name="country" required defaultValue="" autoComplete="country-name" className={cn(field, 'h-11 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9', 'bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23737c8f%27%20stroke-width=%272%27%3E%3Cpath%20d=%27m6%209%206%206%206-6%27/%3E%3C/svg%3E")]')}>
            <option value="" disabled>Select country</option>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pf-role" className={label}>Your role</label>
          <select id="pf-role" name="role" required defaultValue="" className={cn(field, 'h-11 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9', 'bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23737c8f%27%20stroke-width=%272%27%3E%3Cpath%20d=%27m6%209%206%206%206-6%27/%3E%3C/svg%3E")]')}>
            <option value="" disabled>Select role</option>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pf-challenge" className={label}>What slows your billing down?</label>
          <textarea
            id="pf-challenge"
            name="challenge"
            required
            minLength={10}
            maxLength={3000}
            rows={4}
            placeholder="Re-keying pay applications, chasing corrections, retainage tracking…"
            className={cn(field, 'resize-y py-3 leading-relaxed')}
          />
        </div>
      </div>

      {/* Hidden from people; only scripts fill it in. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="pf-website">Website</label>
        <input id="pf-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <label className="mt-5 flex items-start gap-3 text-[13.5px] leading-relaxed text-ink-2">
        <input type="checkbox" name="consent" required className="mt-0.5 size-4 shrink-0 rounded border-line-strong accent-[#1f4fd1]" />
        <span>
          Zephric may contact me about this inquiry. I have read the <LegalLink which="privacy" className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">privacy notice</LegalLink>.
        </span>
      </label>

      <div className="mt-6 flex flex-col-reverse items-stretch gap-4 sm:flex-row sm:items-center">
        <p
          id="partner-status"
          ref={(el) => {
            status.current = el;
          }}
          tabIndex={-1} role={state.kind === 'error' ? 'alert' : 'status'} className={cn('flex-1 text-[13.5px] outline-none', state.kind === 'error' ? 'text-block' : 'text-ink-3')}>
          {state.kind === 'error' ? state.message : 'Do not include confidential project records or payment details.'}
        </p>
        <button
          type="submit"
          disabled={sending}
          className="focus-ring group inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-ink px-6 text-[15px] font-medium text-white transition-colors hover:bg-ink/85 disabled:opacity-70"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : null}
          {sending ? 'Sending…' : 'Send inquiry'}
          {!sending && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
        </button>
      </div>
    </form>
  );
}
