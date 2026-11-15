CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"seq" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"pay_application_id" text,
	"summary" text NOT NULL,
	"data" jsonb,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_on" date,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text NOT NULL,
	"kind" text NOT NULL,
	"to_email" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_ref" text,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"subcontractor_id" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"original_amount" bigint NOT NULL,
	"retainage_work_bps" integer DEFAULT 1000 NOT NULL,
	"retainage_stored_bps" integer DEFAULT 1000 NOT NULL,
	"executed_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"baseline" jsonb,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"page_count" integer,
	"has_text_layer" boolean,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"status_detail" text,
	"segments" jsonb NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"document_id" text NOT NULL,
	"pay_application_id" text,
	"engine" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text NOT NULL,
	"code" text NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"action" text,
	"needs_qualified_review" boolean DEFAULT false NOT NULL,
	"data" jsonb,
	"refs" jsonb,
	"fingerprint" text NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lien_waivers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text NOT NULL,
	"document_id" text NOT NULL,
	"page" integer DEFAULT 1 NOT NULL,
	"waiver_type" text NOT NULL,
	"form_state" text,
	"title" text,
	"claimant" text,
	"customer" text,
	"owner" text,
	"job_description" text,
	"through_date" date,
	"amount" bigint,
	"exceptions" text,
	"signed" text,
	"signer_name" text,
	"signer_title" text,
	"signed_date" date,
	"notarized" text,
	"extracted" jsonb,
	"edited_by" text,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"intake_token" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_intake_token_unique" UNIQUE("intake_token")
);
--> statement-breakpoint
CREATE TABLE "pay_app_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text NOT NULL,
	"sov_line_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"item_no" text,
	"description" text,
	"scheduled_value" bigint,
	"previous" bigint,
	"this_period" bigint,
	"stored" bigint,
	"total" bigint,
	"balance" bigint,
	"retainage" bigint,
	"extracted" jsonb,
	"edit_kind" text,
	"edit_note" text,
	"edited_by" text,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pay_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"contract_id" text,
	"subcontractor_id" text,
	"application_number" integer,
	"period_to" date,
	"status" text DEFAULT 'processing' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_via" text DEFAULT 'upload' NOT NULL,
	"sender_email" text,
	"submitted_by" text,
	"assignee_id" text,
	"engine" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"processing_error" text,
	"stated" jsonb,
	"match_candidates" jsonb,
	"claimed" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"verified" jsonb,
	"signed" text,
	"notarized" text,
	"signature_confirmed_by" text,
	"signature_confirmed_at" timestamp with time zone,
	"claimed_amount" bigint,
	"verified_amount" bigint,
	"open_blocking" integer DEFAULT 0 NOT NULL,
	"open_warnings" integer DEFAULT 0 NOT NULL,
	"submitted_for_approval_at" timestamp with time zone,
	"submitted_for_approval_by" text,
	"hold_since" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_note" text,
	"approved_amount" bigint,
	"approved_retainage" bigint,
	"approved_record" jsonb,
	"transfer_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"number" text,
	"address" text,
	"city" text,
	"state" text,
	"owner_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sov_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"item_no" text NOT NULL,
	"description" text NOT NULL,
	"scheduled_value" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"change_order_id" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subcontractors" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"trade" text,
	"contact_name" text,
	"contact_email" text,
	"phone" text,
	"address" text,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pay_application_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"filename" text,
	"storage_key" text,
	"sha256" text,
	"external_ref" text,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_subcontractor_id_subcontractors_id_fk" FOREIGN KEY ("subcontractor_id") REFERENCES "public"."subcontractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lien_waivers" ADD CONSTRAINT "lien_waivers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lien_waivers" ADD CONSTRAINT "lien_waivers_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lien_waivers" ADD CONSTRAINT "lien_waivers_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lien_waivers" ADD CONSTRAINT "lien_waivers_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_app_lines" ADD CONSTRAINT "pay_app_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_app_lines" ADD CONSTRAINT "pay_app_lines_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_app_lines" ADD CONSTRAINT "pay_app_lines_sov_line_id_sov_lines_id_fk" FOREIGN KEY ("sov_line_id") REFERENCES "public"."sov_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_app_lines" ADD CONSTRAINT "pay_app_lines_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_subcontractor_id_subcontractors_id_fk" FOREIGN KEY ("subcontractor_id") REFERENCES "public"."subcontractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_signature_confirmed_by_users_id_fk" FOREIGN KEY ("signature_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_submitted_for_approval_by_users_id_fk" FOREIGN KEY ("submitted_for_approval_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD CONSTRAINT "pay_applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sov_lines" ADD CONSTRAINT "sov_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sov_lines" ADD CONSTRAINT "sov_lines_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sov_lines" ADD CONSTRAINT "sov_lines_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontractors" ADD CONSTRAINT "subcontractors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_pay_application_id_pay_applications_id_fk" FOREIGN KEY ("pay_application_id") REFERENCES "public"."pay_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_org_seq" ON "audit_events" USING btree ("org_id","seq");--> statement-breakpoint
CREATE INDEX "audit_app" ON "audit_events" USING btree ("pay_application_id");--> statement-breakpoint
CREATE INDEX "change_orders_contract" ON "change_orders" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "comments_app" ON "comments" USING btree ("pay_application_id");--> statement-breakpoint
CREATE INDEX "communications_app" ON "communications" USING btree ("pay_application_id");--> statement-breakpoint
CREATE INDEX "contracts_org_project" ON "contracts" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "documents_app" ON "documents" USING btree ("pay_application_id");--> statement-breakpoint
CREATE INDEX "documents_org_sha" ON "documents" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "extractions_document" ON "extractions" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_app_code_subject" ON "findings" USING btree ("pay_application_id","code","subject_key");--> statement-breakpoint
CREATE INDEX "findings_org_status" ON "findings" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_provider" ON "integrations" USING btree ("org_id","provider");--> statement-breakpoint
CREATE INDEX "invitations_org" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lien_waivers_app" ON "lien_waivers" USING btree ("pay_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("org_id","user_id","read_at");--> statement-breakpoint
CREATE INDEX "pay_app_lines_app" ON "pay_app_lines" USING btree ("pay_application_id");--> statement-breakpoint
CREATE INDEX "pay_apps_org_status" ON "pay_applications" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "pay_apps_contract" ON "pay_applications" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "projects_org" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sov_lines_contract" ON "sov_lines" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "subcontractors_org" ON "subcontractors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "transfers_org" ON "transfers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "transfers_app" ON "transfers" USING btree ("pay_application_id");