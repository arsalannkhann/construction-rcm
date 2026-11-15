'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import { confirmMfaSetupAction, startMfaSetupAction, type MfaSetupStart } from './actions';
import { RecoveryCodes } from './recovery-codes';

export type SetupStep = 'intro' | 'scan' | 'codes';

/**
 * Setting up two-step verification: scan a QR code (or type the key), prove it
 * with a code, then save the recovery codes. Used in a dialog on the profile
 * page and on its own on the page shown when an organisation requires it.
 *
 * Nothing is refreshed until the person is done, so the recovery codes are not
 * swept away by the page changing underneath them.
 */
export function MfaSetupFlow({ onStepChange, onDone, doneLabel }: { onStepChange?: (step: SetupStep, saved: boolean) => void; onDone: () => void; doneLabel: string }) {
  const [step, setStepState] = useState<SetupStep>('intro');
  const [setup, setSetup] = useState<MfaSetupStart | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSavedState] = useState(false);
  const { pending, run } = useAction();

  const setStep = (next: SetupStep) => {
    setStepState(next);
    onStepChange?.(next, saved);
  };
  const setSaved = (next: boolean) => {
    setSavedState(next);
    onStepChange?.(step, next);
  };
  const begin = () => {
    if (!password || pending) return;
    run(() => startMfaSetupAction(password), {
      refresh: false,
      onSuccess: (data) => {
        setSetup(data);
        setCode('');
        setPassword('');
        setStep('scan');
      },
    });
  };
  const digits = code.replace(/\s/g, '');
  const confirm = () => {
    if (!/^\d{6}$/.test(digits) || pending) return;
    run(() => confirmMfaSetupAction(digits), {
      refresh: false,
      onSuccess: (data) => {
        setCodes(data.recoveryCodes);
        setStep('codes');
      },
    });
  };

  if (step === 'intro') {
    return (
      <form
        className="space-y-3 text-[13px] text-ink-2"
        onSubmit={(e) => {
          e.preventDefault();
          begin();
        }}
      >
        <p>You will need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator, 1Password or Authy. After your password, signing in will ask for the 6-digit code it shows.</p>
        <Field label="Current password" hint="To confirm it is you before your phone is linked to this account.">
          <Input type="password" name="current-password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" />
        </Field>
        <Button type="submit" variant="primary" loading={pending} disabled={!password}>
          Set up two-step verification
        </Button>
      </form>
    );
  }

  if (step === 'scan' && setup) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <div className="flex items-start gap-5">
          {/* Drawn on our server: the key is never sent to a QR service. */}
          <img src={setup.qrCode} alt="QR code to scan with your authenticator app" width={152} height={152} className="shrink-0 rounded-md border border-line bg-white p-1" />
          <div className="min-w-0 space-y-2 text-[13px] text-ink-2">
            <p>
              <span className="font-medium text-ink">1.</span> In your authenticator app, add an account and scan this code.
            </p>
            <p>Cannot scan it? Choose to enter a key instead, and type:</p>
            <code className="block select-all break-all rounded bg-sunken px-2 py-1 font-mono text-xs text-ink">{setup.formattedSecret}</code>
            <p className="text-xs text-ink-3">Time-based, 6 digits. Keep this key private: anyone who has it can make your codes.</p>
          </div>
        </div>
        <Field label="2. Enter the 6-digit code the app now shows" hint="It changes every 30 seconds.">
          <Input name="one-time-code" autoComplete="one-time-code" inputMode="numeric" autoFocus maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="num w-36 tracking-widest" />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" loading={pending} disabled={!/^\d{6}$/.test(digits)}>
            Turn on
          </Button>
          <Button variant="ghost" disabled={pending} onClick={begin}>
            Start over with a new key
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-2">Two-step verification is on. Any other device that was signed in to your account has been signed out.</p>
      <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
      <Button variant="primary" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
