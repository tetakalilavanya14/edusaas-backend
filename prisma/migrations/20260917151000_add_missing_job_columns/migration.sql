ALTER TABLE "education"."jobs"
ADD COLUMN "domain_role_id" UUID,
ADD COLUMN "minimum_experience_years" DOUBLE PRECISION DEFAULT 0;

ALTER TABLE "education"."jobs"
ADD CONSTRAINT "jobs_domain_role_id_fkey"
FOREIGN KEY ("domain_role_id")
REFERENCES "education"."domain_roles"("domain_role_id")
ON DELETE SET NULL
ON UPDATE CASCADE;
