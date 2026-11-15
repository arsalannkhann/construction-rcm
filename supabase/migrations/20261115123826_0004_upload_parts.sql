-- Generated from drizzle/0004_upload_parts.sql by `pnpm db:supabase`. Do not edit: change the schema and run `pnpm db:generate` instead.
CREATE TABLE "upload_parts" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"part" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_parts_user_id_upload_id_part_pk" PRIMARY KEY("user_id","upload_id","part")
);
--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_parts_created" ON "upload_parts" USING btree ("created_at");--> statement-breakpoint
-- Like every other table (0002): row level security with no policies, so no role but the owner reaches it.
ALTER TABLE "upload_parts" ENABLE ROW LEVEL SECURITY;
