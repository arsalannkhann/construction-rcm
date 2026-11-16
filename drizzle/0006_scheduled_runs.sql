CREATE TABLE "scheduled_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"ran" integer NOT NULL,
	"queued" integer NOT NULL,
	"failed" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduled_runs_started" ON "scheduled_runs" USING btree ("started_at");--> statement-breakpoint
-- Like every other table (0002): row level security with no policies, so no role but the owner reaches it.
ALTER TABLE "scheduled_runs" ENABLE ROW LEVEL SECURITY;
