/**
 * Publish the migrations in drizzle/ as supabase/migrations/, the directory
 * Supabase's GitHub integration applies. Run after `pnpm db:generate`:
 *
 *   pnpm db:supabase
 *
 * A test fails if the two directories disagree, so a migration cannot be
 * merged without its Supabase copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listMigrations, supabaseMigrationFile } from '../src/db/migrations';

const out = path.join(process.cwd(), 'supabase', 'migrations');
fs.mkdirSync(out, { recursive: true });
const wanted = new Map(listMigrations(path.join(process.cwd(), 'drizzle')).map((m) => [supabaseMigrationFile(m).name, supabaseMigrationFile(m).content]));

for (const existing of fs.readdirSync(out)) {
  if (existing.endsWith('.sql') && !wanted.has(existing)) {
    console.error(`supabase/migrations/${existing} has no counterpart in drizzle/. Remove it by hand if that is intended; it was left in place.`);
    process.exitCode = 1;
  }
}
for (const [name, content] of wanted) {
  const file = path.join(out, name);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) continue;
  fs.writeFileSync(file, content);
  console.log(`wrote supabase/migrations/${name}`);
}
