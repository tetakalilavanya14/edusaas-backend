const express = require("express");
const repo = require("../data");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

async function recalculateCourseProgress(userId, courseId) {
  try {
    const lessons = await repo.lessons.listByCourse(courseId);
    if (!lessons || lessons.length === 0) return;

    const progressList = await repo.progress.listByUser(userId);

    const completedLessonIds = new Set(
      progressList
        .filter((p) => p.completion_flag)
        .map((p) => p.lesson_id)
    );

    let completedCount = 0;

    for (const lesson of lessons) {
      if (completedLessonIds.has(lesson.id)) {
        completedCount++;
      }
    }

    const percentage = Math.min(
      100,
      Math.round((completedCount / lessons.length) * 100)
    );

    await repo.enrollments.update(userId, courseId, {
      completion_percentage: percentage,
      ...(percentage >= 100 ? { status: "completed" } : {}),
    });

    // Award achievement and certificate once the course is completed.
    if (percentage >= 100) {
      const course = await repo.courses.findById(courseId);

      // Reuse an existing certificate if one already exists.
      let certificate = await repo.certificates.findByUserAndCourse(
        userId,
        courseId
      );

      if (!certificate) {
        certificate = await repo.certificates.create({
          user_id: userId,
          course_id: courseId,
        });
      }

      // Prevent duplicate course-completion achievements.
      const existingAchievements =
        await repo.achievements.listByUser(userId);

      const alreadyAwarded = existingAchievements.some(
        (achievement) =>
          achievement.milestone === "Course Completion" &&
          achievement.certificate_id === certificate.id
      );

      if (!alreadyAwarded) {
        await repo.achievements.create({
          user_id: userId,
          badge_name: "Course Completion",
          milestone: "Course Completion",
          certificate_id: certificate.id,
        });
      }
    }
  } catch (err) {
    console.error("Error recalculating course progress:", err);
  }
}

/**
 * @openapi
 * /api/progress:
 *   get:
 *     tags: [Progress]
 *     summary: List progress for the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Array of progress entries }
 */
router.get("/", authRequired, async (req, res, next) => {
  try {
    return res.json(await repo.progress.listByUser(req.user.sub));
  } catch (err) { next(err); }
});

/**
 * @openapi
 * /api/progress/{lessonId}:
 *   patch:
 *     tags: [Progress]
 *     summary: Update progress for a lesson
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: lessonId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               watched_duration: { type: integer }
 *               quiz_score: { type: integer }
 *               assignment_status:
 *                 type: string
 *                 enum: [pending, submitted, graded]
 *               completion_flag: { type: boolean }
 *     responses:
 *       200: { description: Updated progress }
 */
router.patch("/:lessonId", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
    return res.status(403).json({
      error: "Only students can update learning progress.",
    });
  }
    const allowed = ["watched_duration", "quiz_score", "assignment_status", "completion_flag"];
    const data = {};
    if (
      data.assignment_status &&
      !["pending", "submitted", "graded"].includes(data.assignment_status)
    ) {
      return res.status(400).json({
        error: "Invalid assignment status.",
      });
    }

    if (
      data.quiz_score !== undefined &&
      (data.quiz_score < 0 || data.quiz_score > 100)
    ) {
      return res.status(400).json({
        error: "Quiz score must be between 0 and 100.",
      });
    }

    if (
      data.watched_duration !== undefined &&
      data.watched_duration < 0
    ) {
      return res.status(400).json({
        error: "Watched duration cannot be negative.",
      });
    }
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    const lesson = await repo.lessons.findById(req.params.lessonId);
    if (!lesson) return res.status(404).json({ error: "lesson not found" });

    // Check if the lesson has a quiz
    const quiz = await repo.quizzes.findByLessonId(lesson.id);
    
    // Strict requirement: if a quiz exists (and it should for all new lessons), you must score >= 80 to complete
    if (quiz && data.completion_flag) {
      if (data.quiz_score === undefined || data.quiz_score < 80) {
        return res.status(400).json({ error: "You must score at least 80% on the quiz to complete this lesson." });
      }
    }

    const enrollment = await repo.enrollments.findOne(
      req.user.sub,
      lesson.course_id
    );

    if (!enrollment) {
      return res.status(403).json({
        error: "You are not enrolled in this course.",
      });
    }
    const updated = await repo.progress.upsert(req.user.sub, req.params.lessonId, data);
    
    // Recalculate overall course progress
    await recalculateCourseProgress(req.user.sub, lesson.course_id);
    
    return res.json(updated);
  } catch (err) { next(err); }
});

/**
 * @openapi
 * /api/progress/{lessonId}/submit-quiz:
 *   post:
 *     tags: [Progress]
 *     summary: Submit a quiz for secure grading
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:lessonId/submit-quiz", authRequired, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({ error: "Only students can submit quizzes." });
    }

    const { answers } = req.body; // e.g. { "0": 1, "1": 2 }
    if (!answers) return res.status(400).json({ error: "Answers are required." });

    const lesson = await repo.lessons.findById(req.params.lessonId);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });

    const enrollment = await repo.enrollments.findOne(req.user.sub, lesson.course_id);
    if (!enrollment) return res.status(403).json({ error: "You are not enrolled." });

    const quiz = await repo.quizzes.findByLessonId(lesson.id);
    if (!quiz || !quiz.questions) return res.status(404).json({ error: "No quiz found for this lesson." });

    let correct = 0;
    const total = quiz.questions.length;

    quiz.questions.forEach((q, i) => {
      // Compare submitted answer with the securely fetched correct_option
      if (answers[i] === q.correct_option) {
        correct++;
      }
    });

    const score = Math.round((correct / total) * 100);
    const passed = score >= (quiz.passing_score || 80);

    if (passed) {
      // Automatically update progress
      await repo.progress.upsert(req.user.sub, lesson.id, {
        completion_flag: true,
        quiz_score: score,
        watched_duration: (lesson.duration || 0) * 60,
      });
      
      // Recalculate overall course progress
      await recalculateCourseProgress(req.user.sub, lesson.course_id);
    }

    return res.json({ score, passed });
  } catch (err) { next(err); }
});

module.exports = router;
