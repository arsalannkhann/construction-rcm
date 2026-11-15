/**
 * Creates a sign-in and a demo workspace from the command line.
 *
 *   pnpm seed:demo
 *
 * Stop the dev server first: the embedded database can only be open in one
 * process. (You can also do this from the app: sign up, then "Create the demo
 * workspace" on the overview page.)
 *
 * DEMO_EMAIL / DEMO_PASSWORD override the generated credentials.
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db';
import { users } from '../src/db/schema';
import { appUrl } from '../src/server/config';
import { randomToken } from '../src/server/ids';
import { createDemoWorkspace } from '../src/server/services/demo';
import { signUp } from '../src/server/services/team';

async function main() {
  const db = await getDb();
  const email = (process.env.DEMO_EMAIL ?? 'demo@construction-rcm.test').toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  let userId = existing?.id;
  let password: string | null = null;
  if (!userId) {
    password = process.env.DEMO_PASSWORD ?? randomToken(12);
    ({ userId } = await signUp(db, { name: 'Demo User', email, password, orgName: 'My Company' }));
  }
  const started = Date.now();
  const { created } = await createDemoWorkspace(db, userId);
  console.log(created ? `Demo workspace built in ${((Date.now() - started) / 1000).toFixed(1)}s.` : 'This account already has a demo workspace.');
  console.log(`\n  Sign in at ${appUrl()}/login\n  Email:    ${email}`);
  console.log(password ? `  Password: ${password}   (shown once; set DEMO_PASSWORD to choose your own)\n` : '  Password: the one set when this account was created\n');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
