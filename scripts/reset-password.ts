/**
 * Operator recovery: print a one-time password reset link for an account.
 *
 *   pnpm reset-password <email>
 *   pnpm reset-password <email> --reset-two-step
 *
 * For someone who cannot get a link any other way: a sole owner who is locked
 * out, on a deployment that cannot send email. The link uses APP_URL, works
 * once, for 60 minutes, and replaces any earlier unused link for the account.
 * Using it signs the account out everywhere; it does not sign anyone in.
 *
 * `--reset-two-step` also turns off two-step verification, for an owner who
 * has lost their phone and their recovery codes and has no other owner or
 * admin to reset it. Do that only after confirming who you are talking to.
 *
 * Both are recorded in the audit trail of every organisation the account
 * belongs to, as done by the system operator.
 *
 * Run it where the app's database is: with DATABASE_URL set for PostgreSQL,
 * or, for the embedded database, with the app stopped (it opens in one
 * process at a time). Give the link to the person over a channel you trust;
 * it is as good as their password until it is used or expires.
 */
import { closeDb, getDb } from '../src/db';
import { createOperatorResetLink, RESET_LINK_MINUTES } from '../src/server/auth/password-reset';
import { resetMfaByOperator } from '../src/server/auth/mfa';
import { UserError } from '../src/server/auth/permissions';

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const resetTwoStep = args.includes('--reset-two-step');
  const email = args.find((a) => !a.startsWith('--'));
  if (!email) {
    console.error('Usage: pnpm reset-password <email> [--reset-two-step]');
    return 2;
  }
  const db = await getDb();
  if (resetTwoStep) {
    const { name, wasOn } = await resetMfaByOperator(db, email);
    console.log(wasOn ? `Two-step verification for ${name} is now off. They were signed out everywhere and can set it up again after signing in.` : `${name} did not have two-step verification on; nothing to reset.`);
  }
  const { link, expiresAt, name } = await createOperatorResetLink(db, email);
  console.log(`\nOne-time password reset link for ${name}:\n\n  ${link}\n`);
  console.log(`It works once, until ${expiresAt.toISOString()} (${RESET_LINK_MINUTES} minutes from now). Any earlier unused link for this account no longer works.`);
  console.log('Using it signs the account out on every device. It does not sign anyone in, and it does not turn off two-step verification.\n');
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err instanceof UserError ? err.message : err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
