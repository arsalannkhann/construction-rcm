'use client';

import { X } from 'lucide-react';
import { useRef } from 'react';

/** The website's privacy notice and terms, opened in a native modal dialog (focus trap and Escape for free). */
const COPY = {
  privacy: {
    title: 'Privacy notice',
    body: [
      'When you submit an inquiry, we collect your name, work email, company, country, role, and the workflow challenge you choose to share. We use this information to evaluate design partner fit and respond to your inquiry.',
      'Inquiries are stored in Zephric’s database, which is hosted by Supabase; this website runs on Vercel. Do not include confidential project records, payment information, or sensitive personal data. We do not use this form for advertising subscriptions.',
      'To request access, correction, or deletion, use the inquiry form and state your request.',
      'Updated November 16, 2026.',
    ],
  },
  terms: {
    title: 'Website terms',
    body: [
      'This website introduces a product in development. Demonstrations use illustrative data. Product descriptions reflect intended capabilities and may change; they are not a commitment to deliver a specific feature, integration, or availability date.',
      'Submitting an inquiry creates no commercial agreement and does not guarantee early access.',
      'The site and demonstrations do not provide accounting, tax, or legal advice. Your team remains responsible for financial approvals and jurisdiction-specific requirements.',
    ],
  },
} as const;

export function LegalLink({ which, className, children }: { which: keyof typeof COPY; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const copy = COPY[which];
  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.showModal()}>
        {children}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={`legal-${which}`}
        onClick={(e) => e.target === ref.current && ref.current?.close()}
        className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl border border-line bg-surface p-0 text-left text-ink shadow-float backdrop:bg-navy/40 backdrop:backdrop-blur-sm open:animate-pop"
      >
        <div className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <h2 id={`legal-${which}`} className="text-[20px] font-semibold tracking-[-0.015em]">
              {copy.title}
            </h2>
            <button type="button" onClick={() => ref.current?.close()} className="focus-ring -m-2 rounded-lg p-2 text-ink-3 hover:text-ink" aria-label="Close">
              <X className="size-5" />
            </button>
          </div>
          <div className="mt-4 space-y-3 text-[14.5px] leading-relaxed text-ink-2">
            {copy.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
