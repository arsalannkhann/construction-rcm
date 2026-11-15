CREATE TABLE "auth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"succeeded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"message_id" text NOT NULL,
	"from_email" text,
	"subject" text,
	"outcome" text NOT NULL,
	"reason" text,
	"attachments" integer DEFAULT 0 NOT NULL,
	"pay_application_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "retainage_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"effective_on" date NOT NULL,
	"note" text,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_by" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "retainage_terms" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "run_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "header_corrections" jsonb;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "superseded_by_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_recovery_codes" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_counter" integer;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainage_releases" ADD CONSTRAINT "retainage_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainage_releases" ADD CONSTRAINT "retainage_releases_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainage_releases" ADD CONSTRAINT "retainage_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainage_releases" ADD CONSTRAINT "retainage_releases_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_attempts_subject" ON "auth_attempts" USING btree ("subject","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_org_message" ON "inbound_messages" USING btree ("org_id","message_id");--> statement-breakpoint
CREATE INDEX "inbound_messages_org_created" ON "inbound_messages" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "password_resets_user" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "retainage_releases_contract" ON "retainage_releases" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "stored_objects_org" ON "stored_objects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jobs_org" ON "jobs" USING btree ("org_id");