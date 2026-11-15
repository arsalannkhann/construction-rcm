-- Generated from drizzle/0005_inquiries.sql by `pnpm db:supabase`. Do not edit: change the schema and run `pnpm db:generate` instead.
CREATE TABLE "inquiries" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text NOT NULL,
	"country" text NOT NULL,
	"role" text NOT NULL,
	"challenge" text NOT NULL,
	"consent_version" text NOT NULL,
	"sender_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "inquiries_sender_created" ON "inquiries" USING btree ("sender_hash","created_at");--> statement-breakpoint
CREATE INDEX "inquiries_created" ON "inquiries" USING btree ("created_at");--> statement-breakpoint
-- Like every other table (0002): row level security with no policies, so no role but the owner reaches it.
ALTER TABLE "inquiries" ENABLE ROW LEVEL SECURITY;
