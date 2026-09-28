ALTER TABLE "education"."gap_reports"
ADD COLUMN "initial_readiness_score" DOUBLE PRECISION,
ADD COLUMN "final_readiness_score" DOUBLE PRECISION;

CREATE TABLE "education"."mini_project_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "educator_id" UUID NOT NULL,
    "domain_role_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "problem_statement" TEXT NOT NULL,
    "instructions" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    "assigned_at" TIMESTAMP(6),
    "due_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "mini_project_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "education"."mini_project_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assignment_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "repository_url" VARCHAR(500) NOT NULL,
    "branch" VARCHAR(255) NOT NULL DEFAULT 'main',
    "commit_sha" VARCHAR(64),
    "status" VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED',
    "submitted_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mini_project_submissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "education"."mini_project_analysis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "submission_id" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
    "static_analysis_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "plagiarism_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "ai_review_status" VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUESTED',
    "readiness_score" DECIMAL(5,2),
    "languages" JSONB,
    "project_type" VARCHAR(100),
    "started_at" TIMESTAMP(6),
    "completed_at" TIMESTAMP(6),
    "error_message" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mini_project_analysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "education"."static_analysis_findings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "analysis_id" UUID NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "rule" VARCHAR(255) NOT NULL,
    "file" VARCHAR(1000) NOT NULL,
    "line" INTEGER,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "static_analysis_findings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "education"."mini_project_plagiarism_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "analysis_id" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "highest_similarity" DECIMAL(5,2),
    "comparison_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mini_project_plagiarism_checks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "education"."mini_project_plagiarism_matches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plagiarism_check_id" UUID NOT NULL,
    "matched_submission_id" UUID NOT NULL,
    "similarity" DECIMAL(5,2),
    "risk_level" VARCHAR(30),
    "matched_files" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mini_project_plagiarism_matches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mini_project_submissions_assignment_id_student_id_key"
ON "education"."mini_project_submissions"("assignment_id", "student_id");

CREATE INDEX "idx_mini_project_assignments_educator"
ON "education"."mini_project_assignments"("educator_id");

CREATE INDEX "idx_mini_project_assignments_domain_role"
ON "education"."mini_project_assignments"("domain_role_id");

CREATE INDEX "idx_mini_project_assignments_status"
ON "education"."mini_project_assignments"("status");

CREATE INDEX "idx_mini_project_assignments_due_at"
ON "education"."mini_project_assignments"("due_at");

CREATE INDEX "idx_mini_project_submissions_assignment"
ON "education"."mini_project_submissions"("assignment_id");

CREATE INDEX "idx_mini_project_submissions_student"
ON "education"."mini_project_submissions"("student_id");

CREATE INDEX "idx_mini_project_submissions_status"
ON "education"."mini_project_submissions"("status");

CREATE INDEX "idx_mini_project_submissions_commit_sha"
ON "education"."mini_project_submissions"("commit_sha");

CREATE UNIQUE INDEX "mini_project_analysis_submission_id_key"
ON "education"."mini_project_analysis"("submission_id");

CREATE INDEX "idx_mini_project_analysis_status"
ON "education"."mini_project_analysis"("status");

CREATE INDEX "idx_mini_project_analysis_static_status"
ON "education"."mini_project_analysis"("static_analysis_status");

CREATE INDEX "idx_mini_project_analysis_plagiarism_status"
ON "education"."mini_project_analysis"("plagiarism_status");

CREATE INDEX "idx_static_analysis_findings_analysis"
ON "education"."static_analysis_findings"("analysis_id");

CREATE INDEX "idx_static_analysis_findings_severity"
ON "education"."static_analysis_findings"("severity");

CREATE INDEX "idx_static_analysis_findings_category"
ON "education"."static_analysis_findings"("category");

CREATE UNIQUE INDEX "mini_project_plagiarism_checks_analysis_id_key"
ON "education"."mini_project_plagiarism_checks"("analysis_id");

CREATE INDEX "idx_mini_project_plagiarism_matches_check"
ON "education"."mini_project_plagiarism_matches"("plagiarism_check_id");

CREATE INDEX "idx_mini_project_plagiarism_matches_submission"
ON "education"."mini_project_plagiarism_matches"("matched_submission_id");

ALTER TABLE "education"."mini_project_assignments"
ADD CONSTRAINT "mini_project_assignments_educator_id_fkey"
FOREIGN KEY ("educator_id")
REFERENCES "education"."users"("id")
ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "education"."mini_project_assignments"
ADD CONSTRAINT "mini_project_assignments_domain_role_id_fkey"
FOREIGN KEY ("domain_role_id")
REFERENCES "education"."domain_roles"("domain_role_id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "education"."mini_project_submissions"
ADD CONSTRAINT "mini_project_submissions_assignment_id_fkey"
FOREIGN KEY ("assignment_id")
REFERENCES "education"."mini_project_assignments"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "education"."mini_project_submissions"
ADD CONSTRAINT "mini_project_submissions_student_id_fkey"
FOREIGN KEY ("student_id")
REFERENCES "education"."users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "education"."mini_project_analysis"
ADD CONSTRAINT "mini_project_analysis_submission_id_fkey"
FOREIGN KEY ("submission_id")
REFERENCES "education"."mini_project_submissions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "education"."static_analysis_findings"
ADD CONSTRAINT "static_analysis_findings_analysis_id_fkey"
FOREIGN KEY ("analysis_id")
REFERENCES "education"."mini_project_analysis"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "education"."mini_project_plagiarism_checks"
ADD CONSTRAINT "mini_project_plagiarism_checks_analysis_id_fkey"
FOREIGN KEY ("analysis_id")
REFERENCES "education"."mini_project_analysis"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "education"."mini_project_plagiarism_matches"
ADD CONSTRAINT "mini_project_plagiarism_matches_plagiarism_check_id_fkey"
FOREIGN KEY ("plagiarism_check_id")
REFERENCES "education"."mini_project_plagiarism_checks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
