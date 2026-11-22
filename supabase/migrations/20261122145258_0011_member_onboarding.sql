-- Generated from drizzle/0011_member_onboarding.sql by `pnpm db:supabase`. Do not edit: change the schema and run `pnpm db:generate` instead.
ALTER TABLE "memberships" ADD COLUMN "onboarding" jsonb;--> statement-breakpoint
-- People who were members before onboarding existed get an empty record, so the welcome step
-- (shown to a membership with none) does not interrupt them. New memberships start with none.
UPDATE "memberships" SET "onboarding" = '{}'::jsonb;
