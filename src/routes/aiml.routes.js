// src/routes/aiml.routes.js
// Unified authenticated proxy for all 5 AIML models:
//   Sentiment, Toxicity, Fraud, Performance, Skill Demand

const express = require("express");
const router = express.Router();
const { authRequired } = require("../middleware/auth");
const {
  analyzeSentiment,
  analyzeToxicity,
  predictFraud,
  predictPerformance,
  getAvailableSkills,
  forecastSkillDemand,
  forecastSkillBatch,
  predictDropout,
  predictHiring,
  evaluateDescriptiveAnswer,
  analyzeSkillGap,
  checkMiniProjectPlagiarism,
  clerkToInt,
  clerkToUUID,
} = require("../services/aimlClient");

// ─────────────────────────────────────────────────────────────
// Helper: role guard (inline, avoids importing permissionRequired)
// ─────────────────────────────────────────────────────────────
function roleGuard(...allowedRoles) {
  return (req, res, next) => {
    const userRole = (req.user?.role || "").toLowerCase();
    if (allowedRoles.includes(userRole)) return next();
    return res.status(403).json({
      success: false,
      message: `Access denied. Allowed roles: ${allowedRoles.join(", ")}`,
    });
  };
}

// ─────────────────────────────────────────────────────────────
// 1. Sentiment Analysis
// POST /api/aiml/sentiment/predict
// Body: { post_text: string, post_id?: string }
// ─────────────────────────────────────────────────────────────
router.post("/sentiment/predict", authRequired, async (req, res, next) => {
  try {
    const { post_text, post_id = "1" } = req.body;
    if (!post_text || typeof post_text !== "string" || !post_text.trim()) {
      return res.status(400).json({ success: false, message: "post_text is required." });
    }
    const result = await analyzeSentiment({
      student_id: req.user.sub,
      post_id: String(post_id),
      post_text: post_text.substring(0, 5000),
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Sentiment error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 2. Toxicity Detection
// POST /api/aiml/toxicity/predict
// Body: { post_text: string, discussion_id?: string }
// ─────────────────────────────────────────────────────────────
router.post("/toxicity/predict", authRequired, async (req, res, next) => {
  try {
    const { post_text, discussion_id = "0" } = req.body;
    if (!post_text || typeof post_text !== "string" || !post_text.trim()) {
      return res.status(400).json({ success: false, message: "post_text is required." });
    }
    const result = await analyzeToxicity({
      student_id: req.user.sub,
      discussion_id: String(discussion_id),
      post_text: post_text.substring(0, 5000),
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Toxicity error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 3. Fraud Detection
// POST /api/aiml/fraud/predict
// Access: educator, admin only
// Body: FraudRequest fields
// ─────────────────────────────────────────────────────────────
router.post(
  "/fraud/predict",
  authRequired,
  roleGuard("educator", "admin"),
  async (req, res, next) => {
    try {
      const {
        student_id,
        completion_percentage = 0,
        watch_time_minutes = 0,
        quiz_score = 0,
        rating = 0,
        sessions_last_30_days = 0,
        avg_session_minutes = 0,
        videos_watched = 0,
        assignments_attempted = 0,
        discussion_interactions = 0,
        login_count = 0,
        device_count = 0,
        ip_changes = 0,
        suspicious_activity_score = 0,
      } = req.body;

      if (!student_id) {
        return res.status(400).json({ success: false, message: "student_id is required." });
      }

      const result = await predictFraud({
        student_id,
        completion_percentage: Number(completion_percentage),
        watch_time_minutes: Number(watch_time_minutes),
        quiz_score: Number(quiz_score),
        rating: Number(rating),
        sessions_last_30_days: Number(sessions_last_30_days),
        avg_session_minutes: Number(avg_session_minutes),
        videos_watched: Number(videos_watched),
        assignments_attempted: Number(assignments_attempted),
        discussion_interactions: Number(discussion_interactions),
        login_count: Number(login_count),
        device_count: Number(device_count),
        ip_changes: Number(ip_changes),
        suspicious_activity_score: Number(suspicious_activity_score),
      });

      return res.json({ success: true, data: result });
    } catch (err) {
      console.error("[AIML] Fraud error:", err.message);
      return res.status(err.status || 502).json({ success: false, message: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 4. Performance Prediction
// POST /api/aiml/performance/predict
// Body: { avg_quiz_score, avg_assignment_score, assignment_submission_rate, attendance_percentage }
// ─────────────────────────────────────────────────────────────
router.post("/performance/predict", authRequired, async (req, res, next) => {
  try {
    const {
      avg_quiz_score,
      avg_assignment_score,
      assignment_submission_rate,
      attendance_percentage,
    } = req.body;

    if (
      avg_quiz_score === undefined ||
      avg_assignment_score === undefined ||
      assignment_submission_rate === undefined ||
      attendance_percentage === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All fields required: avg_quiz_score, avg_assignment_score, assignment_submission_rate, attendance_percentage",
      });
    }

    const result = await predictPerformance({
      avg_quiz_score: Number(avg_quiz_score),
      avg_assignment_score: Number(avg_assignment_score),
      assignment_submission_rate: Number(assignment_submission_rate),
      attendance_percentage: Number(attendance_percentage),
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Performance error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 5a. Skill Demand — List available skills
// GET /api/aiml/skills
// ─────────────────────────────────────────────────────────────
router.get("/skills", authRequired, async (req, res, next) => {
  try {
    const result = await getAvailableSkills();
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Skills list error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 5b. Skill Demand — Forecast single skill
// GET /api/aiml/skill-demand/:skill?periods=6
// ─────────────────────────────────────────────────────────────
router.get("/skill-demand/:skill", authRequired, async (req, res, next) => {
  try {
    const skill = req.params.skill;
    const periods = Math.min(Math.max(parseInt(req.query.periods || "6", 10), 1), 24);
    const result = await forecastSkillDemand(skill, periods);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Skill demand error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 5c. Skill Demand — Batch forecast
// POST /api/aiml/skill-demand/batch
// Body: { skills: string[], periods?: number }
// ─────────────────────────────────────────────────────────────
router.post("/skill-demand/batch", authRequired, async (req, res, next) => {
  try {
    const { skills, periods = 6 } = req.body;
    if (!Array.isArray(skills) || skills.length === 0) {
      return res.status(400).json({ success: false, message: "skills must be a non-empty array." });
    }
    const safePeriods = Math.min(Math.max(parseInt(periods, 10), 1), 24);
    const result = await forecastSkillBatch(skills, safePeriods);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Batch skill demand error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 6. Student Dropout Risk Prediction
// POST /api/aiml/dropout/predict
// ─────────────────────────────────────────────────────────────
router.post("/dropout/predict", authRequired, async (req, res, next) => {
  try {
    const raw = req.body || {};
    const studentData = {
      student_id: clerkToUUID(raw.student_id || req.user.sub),
      sessions_last_30_days: Number(raw.sessions_last_30_days ?? 8),
      avg_session_minutes: Number(raw.avg_session_minutes ?? 45),
      videos_watched: Number(raw.videos_watched ?? 6),
      assignments_attempted: Number(raw.assignments_attempted ?? 4),
      discussion_interactions: Number(raw.discussion_interactions ?? 2),
      logins_last_30_days: Number(raw.logins_last_30_days ?? 10),
      days_since_last_login: Number(raw.days_since_last_login ?? 2),
      completion_percentage: Number(raw.completion_percentage ?? 50),
      quiz_average: Number(raw.quiz_average ?? 75),
      assignment_completion_rate: Number(raw.assignment_completion_rate ?? 60),
    };

    const result = await predictDropout(studentData);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Dropout prediction error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 7. Predictive Hiring Compatibility Match
// POST /api/aiml/hiring/predict
// ─────────────────────────────────────────────────────────────
router.post("/hiring/predict", authRequired, async (req, res, next) => {
  try {
    const raw = req.body || {};
    const hiringData = {
      experience_years: Number(raw.experience_years ?? 2),
      required_experience_years: Number(raw.required_experience_years ?? 3),
      skill_match_score: Math.min(Math.max(Number(raw.skill_match_score ?? 0.75), 0), 1),
      experience_match_score: Math.min(Math.max(Number(raw.experience_match_score ?? 0.7), 0), 1),
      domain_match: raw.domain_match ? 1 : 0,
      profile_score: Math.min(Math.max(Number(raw.profile_score ?? 80), 0), 100),
    };

    const result = await predictHiring(hiringData);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Hiring prediction error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 8. Descriptive Answer Evaluation (XLNet)
// POST /api/aiml/evaluation/evaluate
// ─────────────────────────────────────────────────────────────
router.post("/evaluation/evaluate", authRequired, async (req, res, next) => {
  try {
    const { question_text, student_answer_text, reference_answer_text } = req.body;
    if (!question_text || !student_answer_text || !reference_answer_text) {
      return res.status(400).json({
        success: false,
        message: "question_text, student_answer_text, and reference_answer_text are required.",
      });
    }

    const result = await evaluateDescriptiveAnswer({
      questionText: question_text,
      studentAnswerText: student_answer_text,
      referenceAnswerText: reference_answer_text,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Evaluation error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 9. AI Skill Gap Analysis
// POST /api/aiml/skill-gap/analyze
// ─────────────────────────────────────────────────────────────
router.post("/skill-gap/analyze", authRequired, async (req, res, next) => {
  try {
    const { student_skills, required_skills } = req.body;
    if (!Array.isArray(student_skills) || !Array.isArray(required_skills)) {
      return res.status(400).json({
        success: false,
        message: "student_skills and required_skills must be arrays.",
      });
    }

    const result = await analyzeSkillGap({ student_skills, required_skills });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Skill gap error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 10. Multi-File Project Plagiarism
// POST /api/aiml/plagiarism/mini-project
// Restricted to Educator and Admin
// ─────────────────────────────────────────────────────────────
router.post("/plagiarism/mini-project", authRequired, roleGuard("educator", "admin"), async (req, res, next) => {
  try {
    const payload = req.body;
    if (!payload?.submission || !payload?.comparison_submissions) {
      return res.status(400).json({
        success: false,
        message: "submission and comparison_submissions are required.",
      });
    }

    const result = await checkMiniProjectPlagiarism(payload);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[AIML] Project plagiarism error:", err.message);
    return res.status(err.status || 502).json({ success: false, message: err.message });
  }
});

module.exports = router;
