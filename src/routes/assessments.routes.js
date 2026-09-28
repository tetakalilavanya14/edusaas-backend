

const express = require("express");
const repo = require("../data");
const { authRequired } = require("../middleware/auth");
const assessmentService = require("../services/assessmentService");
const codingAssessmentService = require("../services/codingAssessmentService")
const aimlClient = require("../services/aimlClient");
console.log("ASSESSMENT SERVICE EXPORTS:", Object.keys(assessmentService));

const router = express.Router();

/**
 * @openapi
 * /api/assessments:
 *   post:
 *     tags: [Assessments]
 *     summary: Submit skill test
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, score]
 *             properties:
 *               type: { type: string, example: javascript-basics }
 *               score: { type: number, example: 82 }
 *               answers:
 *                 type: array
 *                 items: { type: object }
 *     responses:
 *       201: { description: Assessment recorded }
 */
router.post("/", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can submit assessments.",
      });
    }

    const { type, score, answers } = req.body || {};
    if (!type || typeof score !== "number") {
      return res.status(400).json({ error: "type (string) and score (number) are required" });
    }
    if (score < 0 || score > 100) {
      return res.status(400).json({
        error: "Score must be between 0 and 100.",
      });
    }

    if (answers && !Array.isArray(answers)) {
      return res.status(400).json({
        error: "Answers must be an array.",
      });
    }

    const assessment = await repo.assessments.create({
      user_id: req.user.sub,
      type,
      score,
      answers: answers || [],
    });

    try {
      // Mocking session metrics for fraud detection
      const fraudData = {
        student_id: req.user.sub, // Will be hashed inside aimlClient.js
        completion_percentage: 100,
        watch_time_minutes: 60,
        quiz_score: score,
        rating: 4,
        sessions_last_30_days: 10,
        avg_session_minutes: 30,
        videos_watched: 5,
        assignments_attempted: 2,
        discussion_interactions: 1,
        login_count: 5,
        device_count: req.body.device_count || 1, // e.g. from frontend telemetry
        ip_changes: req.body.ip_changes || 0,
        payment_status: "PAID",
        enrollment_source: "WEB",
        enrollment_status: "ACTIVE"
      };

      const fraudResp = await aimlClient.predictFraud(fraudData);

      if (fraudResp && fraudResp.data && fraudResp.data.is_fraudulent) {
        console.warn(`[AIML Fraud] Flagged assessment ${assessment.id} for potential fraud`);
        // We could flag the assessment in DB here
        // await repo.assessments.flagFraud(assessment.id);
      }
    } catch (err) {
      console.warn("[AIML Fraud Detection] Skipped or failed:", err.message);
    }

    return res.status(201).json(assessment);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/assessments/{id}/results:
 *   get:
 *     tags: [Assessments]
 *     summary: Get assessment results
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Assessment with results }
 *       404: { description: Not found }
 */
router.get("/:id/results", authRequired, async (req, res, next) => {
  try {
    const a = await repo.assessments.findById(req.params.id);
    if (!a) {
      return res.status(404).json({
        error: "Assessment not found.",
      });
    }

    const isOwner = a.user_id === req.user.sub;
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        error: "You are not authorized to view this assessment.",
      });
    }
    return res.json(a);
  } catch (err) {
    next(err);
  }
});

router.get("/overview", authRequired, async (req, res) => {
  try {
    const overview = await assessmentService.getAssessmentOverview(req.user.sub)
    return res.json(overview)
  } catch (error) {
    console.error("Failed to get assessment overview", error);
    return res.status(500).json({
      error: "Failed to get assessment overview"
    })
  }
})

// Adaptive initial assessment (React -> Node -> DB -> Node -> AI/ML -> Node -> DB -> React)
router.post("/initial-quiz/start", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can start the initial quiz.",
      });
    }

    const result = await assessmentService.startInitialAssessment(
      req.user.sub
    );

    return res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/initial-quiz/activate", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can start the initial quiz.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result = await assessmentService.activateInitialAssessment(
      req.user.sub,
      sessionId
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/initial-quiz/pause", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can pause the initial quiz.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result =
      await assessmentService.pauseInitialAssessment(
        req.user.sub,
        sessionId
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/initial-quiz/heartbeat", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can send assessment heartbeat.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result =
      await assessmentService.heartbeatInitialAssessment(
        req.user.sub,
        sessionId
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
);

router.post("/initial-quiz/answer", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can submit initial quiz answers.",
      });
    }

    const { session_id, question_id, answer } = req.body || {};

    if (
      session_id === undefined ||
      question_id === undefined ||
      !answer
    ) {
      return res.status(400).json({
        error: "session_id, question_id and answer are required.",
      });
    }

    const sessionId = Number(session_id);
    const questionId = Number(question_id);

    if (!Number.isInteger(sessionId) || !Number.isInteger(questionId)) {
      return res.status(400).json({
        error: "session_id and question_id must be valid integers.",
      });
    }

    const normalizedAnswer = String(answer).trim().toUpperCase();

    if (!["A", "B", "C", "D"].includes(normalizedAnswer)) {
      return res.status(400).json({
        error: "answer must be A, B, C or D.",
      });
    }

    const result = await assessmentService.submitInitialAssessmentAnswer(
      req.user.sub,
      sessionId,
      questionId,
      normalizedAnswer
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// Initial coding assessment

// Initial coding assessment information
router.get("/initial-coding/info", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can access coding assessment information.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        question_count: codingAssessmentService.CODING_QUESTION_COUNT,
        format: "Practical Coding",
      },
    });
  } catch (err) {
    next(err);
  }
});

// React -> Node -> codingAssessmentService -> PostgreSQL / Docker
router.post("/initial-coding/start", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can start the coding assessment.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result = await codingAssessmentService.startAssessment({
      userId: req.user.sub,
      sessionId,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
);

router.post("/initial-coding/run", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can run coding submissions.",
      });
    }

    const result = await codingAssessmentService.runStudentCode({
      userId: req.user.sub,
      ...req.body,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
);

router.post("/initial-coding/submit", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can submit coding answers.",
      });
    }

    const result = await codingAssessmentService.submitCode({
      userId: req.user.sub,
      ...req.body,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
);

router.post("/initial-coding/complete", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can complete the coding assessment.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result = await codingAssessmentService.completeAssessment({
      userId: req.user.sub,
      sessionId,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
);

router.post("/initial-coding/activate", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can activate the coding assessment.",
      });
    }

    const { session_id } = req.body || {};
    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result = await codingAssessmentService.activateAssessment({
      userId: req.user.sub,
      sessionId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.post("/initial-coding/pause", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can pause the coding assessment.",
      });
    }

    const { session_id } = req.body || {};
    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result = await codingAssessmentService.pauseAssessment({
      userId: req.user.sub,
      sessionId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.post("/initial-coding/heartbeat", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can send coding assessment heartbeat.",
      });
    }

    const { session_id } = req.body || {};
    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result = await codingAssessmentService.heartbeatAssessment({
      userId: req.user.sub,
      sessionId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});


//FINAL ASSESSMENT ROUTES

// Final QUIZ API 
// React -> Node -> DB -> Node -> AI/ML -> Node -> DB -> React

router.post("/final-quiz/start", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can start the final quiz.",
      });
    }

    const result = await assessmentService.startFinalAssessment(
      req.user.sub
    );

    return res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/final-quiz/activate", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can activate the final quiz.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result =
      await assessmentService.activateFinalAssessment(
        req.user.sub,
        sessionId
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/final-quiz/pause", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can pause the final quiz.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result =
      await assessmentService.pauseFinalAssessment(
        req.user.sub,
        sessionId
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/final-quiz/heartbeat", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can send final quiz heartbeat.",
      });
    }

    const { session_id } = req.body || {};

    if (session_id === undefined) {
      return res.status(400).json({
        error: "session_id is required.",
      });
    }

    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({
        error: "session_id must be a valid integer.",
      });
    }

    const result =
      await assessmentService.heartbeatFinalAssessment(
        req.user.sub,
        sessionId
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
);

router.post("/final-quiz/answer", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        error: "Only students can submit final quiz answers.",
      });
    }

    const {
      session_id,
      question_id,
      answer,
    } = req.body || {};

    if (
      session_id === undefined ||
      question_id === undefined ||
      !answer
    ) {
      return res.status(400).json({
        error: "session_id, question_id and answer are required.",
      });
    }

    const sessionId = Number(session_id);
    const questionId = Number(question_id);

    if (
      !Number.isInteger(sessionId) ||
      !Number.isInteger(questionId)
    ) {
      return res.status(400).json({
        error: "session_id and question_id must be valid integers.",
      });
    }

    const normalizedAnswer =
      String(answer).trim().toUpperCase();

    if (!["A", "B", "C", "D"].includes(normalizedAnswer)) {
      return res.status(400).json({
        error: "answer must be A, B, C or D.",
      });
    }

    const result =
      await assessmentService.submitFinalAssessmentAnswer(
        req.user.sub,
        sessionId,
        questionId,
        normalizedAnswer
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});



module.exports = router;