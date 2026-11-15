'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAction } from '@/lib/use-action';
import { logoutAction, switchOrgAction } from '../(auth)/actions';
import { MfaSetupFlow } from '../(app)/settings/profile/mfa-setup';

export function MfaRequiredSetup({ orgName, elsewhere }: { orgName: string; elsewhere: { id: string; name: string }[] }) {
  const [busy, setBusy] = useState(false);
  const { pending, run } = useAction();

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-line bg-surface p-5">
        {/* A full page load afterwards, so every part of the app picks up the session's new standing. */}
        <MfaSetupFlow doneLabel={`Continue to ${orgName}`} onDone={() => window.location.assign('/overview')} />
      </div>

      <div className="space-y-3 border-t border-line pt-5 text-[13px] text-ink-2">
        {elsewhere.length > 0 ? (
          <div className="space-y-2">
            <p>Or work in one of your other organisations for now, which do not require it:</p>
            <div className="flex flex-wrap gap-2">
              {elsewhere.map((org) => (
                <Button
                  key={org.id}
                  disabled={pending || busy}
                  onClick={() =>
                    run(() => switchOrgAction(org.id), {
                      refresh: false,
                      onSuccess: () => {
                        setBusy(true);
                        window.location.assign('/overview');
                      },
                    })
                  }
                >
                  Switch to {org.name}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <p>
          Lost access to your phone, or cannot set this up now?{' '}
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => logoutAction()}>
            Sign out
          </button>{' '}
          and ask an owner or admin of {orgName} for help.
        </p>
      </div>
    </div>
  );
}
