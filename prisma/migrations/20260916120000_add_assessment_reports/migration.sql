-- CreateTable
CREATE TABLE "education"."AssessmentReport" (
    "id" SERIAL NOT NULL,
    "student_id" UUID NOT NULL,
    "quiz_session_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'Pending',
    "admin_id" UUID,
    "admin_notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(6),

    CONSTRAINT "AssessmentReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssessmentReport_student_id_idx"
ON "education"."AssessmentReport"("student_id");

-- CreateIndex
CREATE INDEX "AssessmentReport_quiz_session_id_idx"
ON "education"."AssessmentReport"("quiz_session_id");

-- CreateIndex
CREATE INDEX "AssessmentReport_status_idx"
ON "education"."AssessmentReport"("status");

-- CreateIndex
CREATE INDEX "AssessmentReport_created_at_idx"
ON "education"."AssessmentReport"("created_at");

-- AddForeignKey
ALTER TABLE "education"."AssessmentReport"
ADD CONSTRAINT "AssessmentReport_student_id_fkey"
FOREIGN KEY ("student_id")
REFERENCES "education"."users"("id")
ON DELETE CASCADE
ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "education"."AssessmentReport"
ADD CONSTRAINT "AssessmentReport_quiz_session_id_fkey"
FOREIGN KEY ("quiz_session_id")
REFERENCES "education"."quiz_sessions"("session_id")
ON DELETE CASCADE
ON UPDATE NO ACTION;
