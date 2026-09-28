const express = require("express");
const repo = require("../data");
const { authRequired } = require("../middleware/auth");

const router = express.Router();
const uploadAssessmentEvidence = require("../middleware/uploadAssessmentEvidence");

/**
 * Student submits a report for a terminated assessment.
 */
/**
 * Student submits a report for a terminated assessment.
 */
router.post(
  "/",
  authRequired,
  uploadAssessmentEvidence.single("evidence"),
   async (req, res, next) => {
  try {
    const studentId = req.user.sub;
    const {
      quiz_session_id,
      assessment_type = "INITIAL",
      reason,
      additional_evidence,
    } = req.body;

    const evidence = req.file
  ? req.file.filename
  : null

    const sessionId = Number(quiz_session_id);
    const assessmentType = String(assessment_type).toUpperCase();

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "Valid quiz_session_id is required.",
      });
    }

    if (!["INITIAL", "CODING", "FINAL"].includes(assessmentType)) {
      return res.status(400).json({
        error: "Invalid assessment_type.",
      });
    }

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        error: "Reason is required.",
      });
    }

    // The parent QuizSession must exist.
    const session = await repo.quizSessions.findById(sessionId);

    if (!session) {
      return res.status(404).json({
        error: "Assessment session not found.",
      });
    }

    // Make sure the assessment belongs to the logged-in student.
    if (String(session.user_id) !== String(studentId)) {
      return res.status(403).json({
        error: "You can only report your own assessment.",
      });
    }

    // Coding has its own session record.
    if (assessmentType === "CODING") {
      const codingSession =
        await repo.codingSessions.findBySessionAndUser(
          sessionId,
          studentId
        );

      if (!codingSession) {
        return res.status(404).json({
          error: "Coding assessment session not found.",
        });
      }

      if (codingSession.status !== "Terminated") {
        return res.status(400).json({
          error: "Only terminated coding assessments can be reported.",
        });
      }
    } else {
      // Initial and Final assessments use QuizSession status.
      if (session.status !== "Terminated") {
        return res.status(400).json({
          error: "Only terminated assessments can be reported.",
        });
      }

      // Final reports must actually reference a FINAL session.
      if (
        assessmentType === "FINAL" &&
        String(session.assessment_type).toUpperCase() !== "FINAL"
      ) {
        return res.status(400).json({
          error: "The session is not a final assessment.",
        });
      }

      // Initial reports must reference an INITIAL session.
      if (
        assessmentType === "INITIAL" &&
        String(session.assessment_type).toUpperCase() !== "INITIAL"
      ) {
        return res.status(400).json({
          error: "The session is not an initial assessment.",
        });
      }
    }

    // Prevent duplicate reports for the same assessment.
    const existingReport =
      await repo.assessmentReports.findByStudentAndSession(
        studentId,
        sessionId
      );

    if (existingReport) {
      return res.status(409).json({
        error: "You have already submitted a report for this assessment.",
        report: existingReport,
      });
    }

    const report = await repo.assessmentReports.create({
      student_id: studentId,
      quiz_session_id: sessionId,
      reason: String(reason).trim(),
      additional_evidence: additional_evidence
  ? String(additional_evidence).trim()
  : null,
      evidence: evidence ? String(evidence).trim() : null,
    });

    return res.status(201).json({
      message: "Assessment report submitted successfully.",
      report,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Student views their own assessment reports.
 */
router.get("/", authRequired, async (req, res, next) => {
  try {
    const reports = await repo.assessmentReports.findByStudent(req.user.sub);

    return res.json(reports);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
