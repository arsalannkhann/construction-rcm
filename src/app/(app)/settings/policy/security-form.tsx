'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/data';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { pluralize } from '@/lib/utils';
import { updatePolicyAction } from './actions';

/**
 * Whether every member must use two-step verification. Owners and admins only:
 * it decides who can get into the organisation at all.
 */
export function SecurityForm({ requireMfa, canEdit, viewerHasMfa, withoutMfa, orgName }: { requireMfa: boolean; canEdit: boolean; viewerHasMfa: boolean; withoutMfa: number; orgName: string }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, run } = useAction();
  const turningOn = !requireMfa;
  const blockedForViewer = turningOn && !viewerHasMfa;

  return (
    <div className="space-y-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-8">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            Require two-step verification for every member
            {requireMfa ? <Badge tone="pass">Required</Badge> : <Badge tone="neutral">Not required</Badge>}
          </p>
          <p className="mt-0.5 max-w-xl text-xs text-ink-3">
            When this is on, a member who has not set up two-step verification cannot open anything in {orgName}. The next time they sign in, or move to another page, they are asked to set it up first.
          </p>
        </div>
        {canEdit ? (
          <div className="shrink-0">
            <Button variant={turningOn ? 'primary' : 'secondary'} disabled={pending || blockedForViewer} onClick={() => setConfirming(true)}>
              {turningOn ? 'Require it…' : 'Stop requiring it…'}
            </Button>
          </div>
        ) : null}
      </div>

      {canEdit && blockedForViewer ? (
        <Notice tone="neutral">
          Turn on two-step verification for your own account first, in{' '}
          <Link href="/settings/profile#two-step" className="font-medium text-accent hover:underline">
            Settings → Profile
          </Link>
          . Requiring it before you have it would shut you out of {orgName} with the same click.
        </Notice>
      ) : null}
      {!canEdit ? <p className="text-xs text-ink-3">Only an owner or admin can change this.</p> : null}
      {withoutMfa > 0 ? (
        <p className="text-xs text-ink-2">
          {pluralize(withoutMfa, 'active member')} {withoutMfa === 1 ? 'has' : 'have'} not set it up yet{requireMfa ? ' and cannot work here until they do' : ''}. See the Two-step column in{' '}
          <Link href="/settings/team" className="font-medium text-accent hover:underline">
            Settings → Team
          </Link>
          .
        </p>
      ) : (
        <p className="text-xs text-ink-2">Every active member has set it up.</p>
      )}

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        size="sm"
        title={turningOn ? 'Require two-step verification?' : 'Stop requiring two-step verification?'}
        description={
          turningOn
            ? `${withoutMfa > 0 ? `${pluralize(withoutMfa, 'member')} without it will be stopped at their next page and asked to set it up before they can continue. ` : ''}Members who already use it notice nothing. This is recorded in the audit log.`
            : 'Members can then sign in with their password alone and turn two-step verification off for themselves. Those who use it keep it. This is recorded in the audit log.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant={turningOn ? 'primary' : 'danger'}
              loading={pending}
              onClick={() =>
                run(() => updatePolicyAction({ requireMfa: turningOn }), {
                  success: turningOn ? 'Two-step verification is now required' : 'Two-step verification is no longer required',
                  onSuccess: () => setConfirming(false),
                })
              }
            >
              {turningOn ? 'Require it' : 'Stop requiring it'}
            </Button>
          </>
        }
      />
    </div>
  );
}
