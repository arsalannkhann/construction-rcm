CREATE TABLE "portal_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"link_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"kind" text NOT NULL,
	"period" text,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_ref" text,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"email" text,
	"reminders" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "portal_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "portal_upload_parts" (
	"link_id" text NOT NULL,
	"org_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"part" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_upload_parts_link_id_upload_id_part_pk" PRIMARY KEY("link_id","upload_id","part")
);
--> statement-breakpoint
ALTER TABLE "portal_emails" ADD CONSTRAINT "portal_emails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_emails" ADD CONSTRAINT "portal_emails_link_id_portal_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."portal_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_emails" ADD CONSTRAINT "portal_emails_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_emails" ADD CONSTRAINT "portal_emails_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_upload_parts" ADD CONSTRAINT "portal_upload_parts_link_id_portal_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."portal_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_upload_parts" ADD CONSTRAINT "portal_upload_parts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_emails_org_contract" ON "portal_emails" USING btree ("org_id","contract_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_emails_reminder_once" ON "portal_emails" USING btree ("contract_id","kind","period");--> statement-breakpoint
CREATE INDEX "portal_links_org_contract" ON "portal_links" USING btree ("org_id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_links_live" ON "portal_links" USING btree ("contract_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "portal_upload_parts_created" ON "portal_upload_parts" USING btree ("created_at");--> statement-breakpoint
-- Like every other table (0002): row level security with no policies, so no role but the owner reaches them.
ALTER TABLE "portal_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_upload_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_emails" ENABLE ROW LEVEL SECURITY;
