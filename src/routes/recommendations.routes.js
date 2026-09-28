const express = require("express");
const repo = require("../data");
const { authRequired } = require("../middleware/auth");
const aimlClient = require("../services/aimlClient");

const router = express.Router();

/**
 * @openapi
 * /api/recommendations:
 *   get:
 *     tags: [Recommendations]
 *     summary: Course recommendations for the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of recommendations with course info
 */
router.get("/", authRequired, async (req, res, next) => {
  try {
    // Recommendations are intended for students who completed the assessment.
    if (req.user.role !== "student") {
      return res.json([]);
    }

    const profile = await repo.profiles.findByUserId(req.user.sub);
    const completedSession = await repo.quizSessions.findCompletedByUser(req.user.sub);
    if (!profile?.initial_assessment_completed && !completedSession) {
      return res.json([]);
    }

    const recommendations =
      await repo.recommendations.listByUser(req.user.sub);

    const manualResult = await Promise.all(
      recommendations.map(async (recommendation) => {
        const course = await repo.courses.findById(
          recommendation.course_id
        );

        return {
          ...recommendation,
          course,
          source: 'manual'
        };
      })
    );

    let aiResult = [];
    try {
      const allCourses = (await repo.courses.list()) || [];
      const userEnrollments = (await repo.enrollments.listByUser(req.user.sub)) || [];
      const completedCourses = userEnrollments
        .filter((e) => e.status === "completed" || e.completed)
        .map((e) => {
          const matchedCourse = allCourses.find((c) => String(c.id) === String(e.course_id));
          const courseTitle = matchedCourse?.title || e.course?.title || "Completed Course";
          return {
            course_id: String(e.course_id),
            id: String(e.course_id),
            course_name: courseTitle,
            title: courseTitle,
          };
        });

      let baseCourseName = "Machine Learning";
      if (userEnrollments.length > 0) {
        const lastCourse = allCourses.find((c) => c.id === userEnrollments[0].course_id);
        if (lastCourse && lastCourse.title) baseCourseName = lastCourse.title;
      } else if (allCourses.length > 0 && allCourses[0].title) {
        baseCourseName = allCourses[0].title;
      }

      const formattedCourses = allCourses.map((c) => ({
        id: String(c.id),
        title: String(c.title || ""),
        category: String(c.category || "Computer Science"),
        difficulty: String(c.difficulty || "Beginner"),
      }));

      const aiData = await aimlClient.getRecommendations({
        userId: req.user.sub,
        courseName: baseCourseName,
        courses: formattedCourses,
        completedCourses: completedCourses,
      });

      if (aiData && aiData.success && aiData.data) {
        // Resolve any missing pathway step course_name using allCourses catalog
        const resolvedPathway = (aiData.data.learning_pathway || []).map((step) => {
          if (step && (!step.course_name || String(step.course_name).trim() === "")) {
            const matched = allCourses.find((c) => String(c.id) === String(step.course_id));
            if (matched && matched.title) {
              return { ...step, course_name: matched.title };
            }
          }
          return step;
        });

        aiResult = [{
          type: "ai_suggestions",
          suggestions: aiData.data.recommendations || aiData.data,
          learning_pathway: resolvedPathway,
          source: "ai",
        }];
      }
    } catch (aiErr) {
      console.warn("[AIML] Recommendation engine fallback triggered:", aiErr.message);
    }

    return res.json([...manualResult, ...aiResult]);

  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/recommendations:
 *   post:
 *     tags: [Recommendations]
 *     summary: Create a recommendation (Admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *               - course_id
 *             properties:
 *               user_id:
 *                 type: string
 *               course_id:
 *                 type: string
 *               reason:
 *                 type: string
 *     responses:
 *       201:
 *         description: Recommendation created
 */
router.post("/", authRequired, async (req, res, next) => {
  try {
    // Only admins can manually create recommendations.
    if (req.user.role !== "admin") {
      return res.status(403).json({
        error: "Only administrators can create recommendations.",
      });
    }

    const { user_id, course_id, reason } = req.body || {};

    if (!user_id || !course_id) {
      return res.status(400).json({
        error: "user_id and course_id are required.",
      });
    }

    const user = await repo.users.findById(user_id);

    if (!user) {
      return res.status(404).json({
        error: "User not found.",
      });
    }

    const course = await repo.courses.findById(course_id);

    if (!course) {
      return res.status(404).json({
        error: "Course not found.",
      });
    }

    const recommendation = await repo.recommendations.create({
      user_id,
      course_id,
      reason,
    });

    return res.status(201).json(recommendation);

  } catch (err) {
    next(err);
  }
});

module.exports = router;