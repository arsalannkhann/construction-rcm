'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireUser, sessionToken } from '@/server/auth/session';
import { changePassword, updateProfile } from '@/server/services/team';

export async function updateProfileAction(input: { name: string }): Promise<ActionResult> {
  return run(async () => {
    const user = await requireUser();
    await updateProfile(await getDb(), user.id, input);
    return undefined;
  });
}

export async function changePasswordAction(input: { current: string; next: string }): Promise<ActionResult> {
  return run(async () => {
    const user = await requireUser();
    // Keep the session making this request; every other session for the account is signed out.
    const keepToken = await sessionToken();
    await changePassword(await getDb(), user.id, input.current, input.next, keepToken ?? undefined);
    return undefined;
  });
}
