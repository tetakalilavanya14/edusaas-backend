const express = require("express");
const skillGapService = require("../services/skillGapService");

const router = express.Router();

/**
 * @openapi
 * /api/skill-gap-analysis/{userId}:
 *   get:
 *     tags: [SkillGapAnalysis]
 *     summary: Get a user's quiz and coding skill-gap analysis
 *     description: Public endpoint that returns the completed initial quiz percentage, coding assessment percentage, and performance for each skill required by the user's domain role.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: User ID to analyze
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Skill-gap analysis
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                   format: uuid
 *                 domainRole:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     name: { type: string, example: AI Engineer }
 *                 quiz:
 *                   type: object
 *                   properties:
 *                     sessionId: { type: integer, example: 7 }
 *                     percentage: { type: number, format: float, example: 51.89 }
 *                 codingAssessment:
 *                   type: object
 *                   properties:
 *                     sessionId: { type: integer, example: 7 }
 *                     totalScore: { type: number, example: 230 }
 *                     maxScore: { type: number, example: 300 }
 *                     percentage: { type: number, format: float, example: 76.67 }
 *                     completedAt: { type: string, format: date-time }
 *                 skills:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       skillId: { type: integer, example: 1 }
 *                       skillName: { type: string, example: Python }
 *                       requiredLevel: { type: integer, example: 5 }
 *                       skillLevel: { type: integer, example: 2 }
 *                       quizPercentage: { type: number, format: float, example: 41.18 }
 *                       performancePercentage: { type: number, format: float, example: 40 }
 *                       gapPercentage: { type: number, format: float, example: 60 }
 *       400:
 *         description: User has not selected a domain role
 *       404:
 *         description: User or domain skills not found
 *       200 (assignment incomplete):
 *         description: If the initial quiz or coding assessment is not completed yet, returns 200 with empty data (quiz/codingAssessment = null, skills = []) instead of an error. The data loads automatically once the assessments are completed.
 */
router.get("/:userId", async (req, res, next) => {
	try {
		const { userId } = req.params;

		const analysis = await skillGapService.getSkillGapAnalysis(userId);
		return res.json(analysis);
	} catch (error) {
		next(error);
	}
});

module.exports = router;
