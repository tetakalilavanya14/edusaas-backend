ALTER TABLE "education"."jobs"
ALTER COLUMN "application_deadline" TYPE VARCHAR(100)
USING "application_deadline"::TEXT;
