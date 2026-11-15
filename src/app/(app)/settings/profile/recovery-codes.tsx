'use client';

import { Check, Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/form';

/**
 * Ten one-time recovery codes, shown once. They are only in this browser's
 * memory: once this is closed they cannot be shown again, only replaced.
 */
export function RecoveryCodes({ codes, saved, onSavedChange }: { codes: string[]; saved: boolean; onSavedChange: (saved: boolean) => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Your browser did not allow copying. Select the codes and copy them with Ctrl+C or ⌘C, or download them.');
    }
  };
  const download = () => {
    const body = ['Zephric recovery codes', '', 'Each code works once, in place of a code from your authenticator app.', '', ...codes, ''].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zephric-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <Notice tone="warn">Save these now. They are shown only this once. Each works one time, if you cannot use your authenticator app.</Notice>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-line bg-canvas px-4 py-3 font-mono text-[13px] text-ink" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button onClick={copy}>
          {copied ? <Check className="size-3.5 text-pass" strokeWidth={2.2} /> : <Copy className="size-3.5" strokeWidth={1.9} />}
          {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button onClick={download}>
          <Download className="size-3.5" strokeWidth={1.9} />
          Download
        </Button>
      </div>
      <Checkbox checked={saved} onChange={(e) => onSavedChange(e.target.checked)} label="I have saved these codes somewhere safe" description="For example in your password manager. Not in an email to yourself." />
    </div>
  );
}
