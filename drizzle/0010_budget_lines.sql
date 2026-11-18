CREATE TABLE "budget_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"from_line_id" text,
	"to_line_id" text,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_by" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"cost_code" text NOT NULL,
	"description" text NOT NULL,
	"original_amount" bigint NOT NULL,
	"forecast_method" text DEFAULT 'remaining' NOT NULL,
	"forecast_amount" bigint,
	"forecast_note" text,
	"forecast_by" text,
	"forecast_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "budget_line_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "budget_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "budget_locked_by" text;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_from_line_id_budget_lines_id_fk" FOREIGN KEY ("from_line_id") REFERENCES "public"."budget_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_to_line_id_budget_lines_id_fk" FOREIGN KEY ("to_line_id") REFERENCES "public"."budget_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_forecast_by_users_id_fk" FOREIGN KEY ("forecast_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_changes_org_project" ON "budget_changes" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "budget_lines_org_project" ON "budget_lines" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_code" ON "budget_lines" USING btree ("project_id","cost_code");--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_budget_line_id_budget_lines_id_fk" FOREIGN KEY ("budget_line_id") REFERENCES "public"."budget_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_budget_locked_by_users_id_fk" FOREIGN KEY ("budget_locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Like every other table (0002): row level security with no policies, so no role but the owner reaches them.
ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budget_changes" ENABLE ROW LEVEL SECURITY;
