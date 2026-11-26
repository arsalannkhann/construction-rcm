-- Generated from drizzle/0012_upload_notes.sql by `pnpm db:supabase`. Do not edit: change the schema and run `pnpm db:generate` instead.
ALTER TABLE "pay_applications" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "stated_amount" bigint;