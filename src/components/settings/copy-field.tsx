'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';

/** A read-only value (a link, an endpoint) with a button that copies it. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // The browser can refuse clipboard access (permissions, a page not served over HTTPS).
      // Leave the text selected so it can be copied with the keyboard.
      input.current?.focus();
      input.current?.select();
      toast.error('Your browser did not allow copying. The text is selected — copy it with Ctrl+C or ⌘C.');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input ref={input} readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 bg-canvas font-mono text-xs" />
      <Button onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`} className="w-[86px]">
        {copied ? <Check className="size-3.5 text-pass" strokeWidth={2.2} /> : <Copy className="size-3.5" strokeWidth={1.9} />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
