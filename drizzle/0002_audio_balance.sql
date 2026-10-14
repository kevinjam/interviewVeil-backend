CREATE TABLE "audio_balance" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer NOT NULL,
	"allowance" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_balance_non_negative" CHECK ("audio_balance"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audio_balance" ADD CONSTRAINT "audio_balance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "audio_balance" ("user_id", "balance", "allowance", "period_start", "period_end")
SELECT
  tb."user_id",
  CASE u."plan"::text
    WHEN 'essential' THEN 7200
    WHEN 'professional' THEN 21600
    WHEN 'expert' THEN 54000
    ELSE 600
  END,
  CASE u."plan"::text
    WHEN 'essential' THEN 7200
    WHEN 'professional' THEN 21600
    WHEN 'expert' THEN 54000
    ELSE 600
  END,
  tb."period_start",
  tb."period_end"
FROM "token_balance" tb
INNER JOIN "users" u ON u."id" = tb."user_id"
ON CONFLICT ("user_id") DO NOTHING;
