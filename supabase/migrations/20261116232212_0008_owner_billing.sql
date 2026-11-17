-- Generated from drizzle/0008_owner_billing.sql by `pnpm db:supabase`. Do not edit: change the schema and run `pnpm db:generate` instead.
CREATE TABLE "owner_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prime_contract_id" text NOT NULL,
	"application_number" integer NOT NULL,
	"period_to" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"entries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"prepared_by" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"record" jsonb,
	"amount_due" bigint,
	"certified_amount" bigint,
	"certified_on" date,
	"certification_note" text,
	"certified_by" text,
	"certified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prime_change_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"prime_contract_id" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prime_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" text,
	"architect_name" text,
	"original_amount" bigint NOT NULL,
	"retainage_work_bps" integer DEFAULT 1000 NOT NULL,
	"retainage_stored_bps" integer DEFAULT 1000 NOT NULL,
	"executed_on" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prime_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"prime_contract_id" text NOT NULL,
	"item_no" text NOT NULL,
	"description" text NOT NULL,
	"scheduled_value" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"basis" text DEFAULT 'manual' NOT NULL,
	"contract_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_applications" ADD CONSTRAINT "owner_applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_applications" ADD CONSTRAINT "owner_applications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_applications" ADD CONSTRAINT "owner_applications_prime_contract_id_prime_contracts_id_fk" FOREIGN KEY ("prime_contract_id") REFERENCES "public"."prime_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_applications" ADD CONSTRAINT "owner_applications_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_applications" ADD CONSTRAINT "owner_applications_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_applications" ADD CONSTRAINT "owner_applications_certified_by_users_id_fk" FOREIGN KEY ("certified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_change_orders" ADD CONSTRAINT "prime_change_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_change_orders" ADD CONSTRAINT "prime_change_orders_prime_contract_id_prime_contracts_id_fk" FOREIGN KEY ("prime_contract_id") REFERENCES "public"."prime_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_contracts" ADD CONSTRAINT "prime_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_contracts" ADD CONSTRAINT "prime_contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_contracts" ADD CONSTRAINT "prime_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_lines" ADD CONSTRAINT "prime_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_lines" ADD CONSTRAINT "prime_lines_prime_contract_id_prime_contracts_id_fk" FOREIGN KEY ("prime_contract_id") REFERENCES "public"."prime_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prime_lines" ADD CONSTRAINT "prime_lines_change_order_id_prime_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."prime_change_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_applications_number" ON "owner_applications" USING btree ("prime_contract_id","application_number");--> statement-breakpoint
CREATE INDEX "owner_applications_org_project" ON "owner_applications" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "prime_change_orders_contract" ON "prime_change_orders" USING btree ("prime_contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prime_contracts_project" ON "prime_contracts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "prime_contracts_org" ON "prime_contracts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "prime_lines_contract" ON "prime_lines" USING btree ("prime_contract_id");--> statement-breakpoint
-- Like every other table (0002): row level security with no policies, so no role but the owner reaches them.
ALTER TABLE "prime_contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prime_change_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prime_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owner_applications" ENABLE ROW LEVEL SECURITY;
