-- Generated from drizzle/0002_deny_data_api.sql by `pnpm db:supabase`. Do not edit: change the schema and run `pnpm db:generate` instead.
-- Keep the records out of reach of any API that talks to the database for
-- someone other than this application.
--
-- Supabase publishes every table in the public schema through its Data API
-- (PostgREST) to the anon, authenticated and service_role roles, and grants
-- those roles full privileges on new tables by default. The anon key is public
-- by design, so without this a project's financial records would be readable
-- and writable by anyone who has the project URL. This application never uses
-- that API: the server connects as the role that owns the tables.
--
-- Two independent locks:
--   1. Row level security on every table, with no policies. Roles other than
--      the owner see no rows and can change none. The owner (this application)
--      is not affected, because RLS is not forced.
--   2. No privileges for the API roles on existing tables and sequences, and
--      none on tables and sequences this role creates later.
--
-- On a plain PostgreSQL server the API roles do not exist and only the first
-- lock applies, which changes nothing for the application.
DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END
$$;
