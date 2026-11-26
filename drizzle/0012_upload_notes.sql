ALTER TABLE "pay_applications" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "pay_applications" ADD COLUMN "stated_amount" bigint;