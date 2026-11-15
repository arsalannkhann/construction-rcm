'use client';

import { LogOut, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { disableMfaAction, regenerateRecoveryCodesAction, revokeOtherSessionsAction, revokeSessionAction } from './actions';
import { MfaSetupFlow, type SetupStep } from './mfa-setup';
import { RecoveryCodes } from './recovery-codes';

const looksLikeCode = (value: string) => /^\d{6}$/.test(value.replace(/\s/g, '')) || value.toLowerCase().replace(/[^a-z0-9]/g, '').length === 10;

export function SetUpMfaButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [key, setKey] = useState(0);

  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          setKey((k) => k + 1);
          setLocked(false);
          setOpen(true);
        }}
      >
        <ShieldCheck className="size-3.5" strokeWidth={1.9} />
        Set up two-step verification
      </Button>
      <Dialog
        open={open}
        // Once it is on, the recovery codes are on screen: closing is only allowed after they are saved.
        onOpenChange={(next) => {
          if (!next && locked) return;
          setOpen(next);
        }}
        title="Set up two-step verification"
      >
        <MfaSetupFlow
          key={key}
          doneLabel="Done"
          onStepChange={(step: SetupStep, saved) => setLocked(step === 'codes' && !saved)}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      </Dialog>
    </>
  );
}

/** Password and code, which turning it off and replacing recovery codes both need. */
function Reauth({ password, code, setPassword, setCode, email }: { password: string; code: string; setPassword: (v: string) => void; setCode: (v: string) => void; email: string }) {
  return (
    <>
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label="Current password">
        <Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Code from your authenticator app" hint="Or one of your recovery codes, which is then used up.">
        <Input autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="num w-44 tracking-widest" />
      </Field>
    </>
  );
}

export function ManageMfa({ email, requiredBy }: { email: string; requiredBy: string[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<'off' | 'codes' | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const { pending, run } = useAction();

  const open = (next: 'off' | 'codes') => {
    setPassword('');
    setCode('');
    setCodes(null);
    setSaved(false);
    setMode(next);
  };
  const ready = password.length > 0 && looksLikeCode(code);
  const close = () => {
    setMode(null);
    router.refresh();
  };

  return (
    <div className="flex gap-2">
      <Button onClick={() => open('codes')}>Replace recovery codes…</Button>
      <Button variant="danger-outline" onClick={() => open('off')}>
        Turn off…
      </Button>

      <Dialog
        open={mode === 'codes'}
        onOpenChange={(next) => {
          if (!next && codes && !saved) return;
          if (!next) close();
        }}
        title={codes ? 'Your new recovery codes' : 'Replace recovery codes'}
        description={codes ? undefined : 'You get ten new codes. The ones you have now stop working straight away.'}
        footer={
          codes ? (
            <Button variant="primary" disabled={!saved} onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={pending} disabled={!ready} onClick={() => run(() => regenerateRecoveryCodesAction({ password, code }), { refresh: false, onSuccess: (data) => setCodes(data.recoveryCodes) })}>
                Replace codes
              </Button>
            </>
          )
        }
      >
        {codes ? (
          <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
        ) : (
          <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
            <Reauth password={password} code={code} setPassword={setPassword} setCode={setCode} email={email} />
          </form>
        )}
      </Dialog>

      <Dialog
        open={mode === 'off'}
        onOpenChange={(next) => (next ? null : setMode(null))}
        size="sm"
        title="Turn off two-step verification?"
        description="Signing in will need only your password. Your authenticator app and recovery codes stop working for this account."
        footer={
          <>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} disabled={!ready} onClick={() => run(() => disableMfaAction({ password, code }), { success: 'Two-step verification is off', onSuccess: () => setMode(null) })}>
              Turn off
            </Button>
          </>
        }
      >
        <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
          {requiredBy.length > 0 ? (
            <Notice tone="warn">
              {requiredBy.join(', ')} {requiredBy.length === 1 ? 'requires' : 'require'} two-step verification. Until you turn it on again, you will not be able to work there.
            </Notice>
          ) : null}
          <Reauth password={password} code={code} setPassword={setPassword} setCode={setCode} email={email} />
        </form>
      </Dialog>
    </div>
  );
}

export function RevokeSessionButton({ id, device }: { id: string; device: string }) {
  const { pending, run } = useAction();
  return (
    <Button variant="ghost" size="sm" loading={pending} aria-label={`Sign out ${device}`} onClick={() => run(() => revokeSessionAction(id), { success: `Signed out ${device}` })}>
      Sign out
    </Button>
  );
}

export function RevokeOtherSessionsButton({ count }: { count: number }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, run } = useAction();
  return (
    <>
      <Button size="sm" onClick={() => setConfirming(true)}>
        <LogOut className="size-3.5" strokeWidth={1.9} />
        Sign out all other sessions
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        size="sm"
        title={`Sign out ${count === 1 ? 'the other session' : `all ${count} other sessions`}?`}
        description="Anyone using them will have to sign in again. This device stays signed in."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={() =>
                run(() => revokeOtherSessionsAction(), {
                  success: (n) => (n === 1 ? 'Signed out 1 other session' : `Signed out ${n} other sessions`),
                  onSuccess: () => setConfirming(false),
                })
              }
            >
              Sign out
            </Button>
          </>
        }
      />
    </>
  );
}
