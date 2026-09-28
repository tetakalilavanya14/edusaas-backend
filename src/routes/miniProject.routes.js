const express = require("express");
const repo = require("../data");
const {
  authRequired,
  roleRequired,
  permissionRequired,
} = require("../middleware/auth");
const { validateRepository } = require("../services/githubService");

const router = express.Router();

/**
 * @openapi
 * /api/mini-projects:
 *   post:
 *     tags: [Mini Projects]
 *     summary: Create a mini project assignment
 *     description: Educator creates a domain-specific mini project problem statement.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - domain_role_id
 *               - title
 *               - problem_statement
 *             properties:
 *               domain_role_id:
 *                 type: string
 *                 format: uuid
 *               title:
 *                 type: string
 *               problem_statement:
 *                 type: string
 *               instructions:
 *                 type: string
 *               due_at:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Mini project created
 */
router.post( "/", authRequired, permissionRequired("mini-projects:create"), async (req, res, next) => {
    try {
      const {
        domain_role_id,
        title,
        problem_statement,
        instructions,
        due_at,
      } = req.body || {};

      if (!domain_role_id) {
        return res.status(400).json({
          error: "domain_role_id is required.",
        });
      }

      if (!title || !title.trim()) {
        return res.status(400).json({
          error: "title is required.",
        });
      }

      if (!problem_statement || !problem_statement.trim()) {
        return res.status(400).json({
          error: "problem_statement is required.",
        });
      }

      let dueAt;

      if (due_at) {
        dueAt = new Date(due_at);

        if (Number.isNaN(dueAt.getTime())) {
          return res.status(400).json({
            error: "Invalid due_at.",
          });
        }
      }

     

      const domainRole = await repo.domainRoles.findById(domain_role_id);

      if (!domainRole) {
        return res.status(404).json({
          error: "Domain role not found.",
        });
      }

    const assignment = await repo.miniProjects.createAssignment({
        educator_id: req.user.sub,
        domain_role_id,
        title,
        problem_statement,
        instructions,
        due_at: dueAt,
        });
        return res.status(201).json(assignment)
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/mini-projects/{id}/publish:
 *   post:
 *     tags: [Mini Projects]
 *     summary: Publish a mini project assignment
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               due_at:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Mini project published
 */
router.post("/:id/publish", authRequired, permissionRequired("mini-projects:publish"), async (req, res, next) => {
    try {
      let dueAt;

      if (req.body?.due_at) {
        dueAt = new Date(req.body.due_at);

        if (Number.isNaN(dueAt.getTime())) {
          return res.status(400).json({
            error: "Invalid due_at.",
          });
        }
      }

      const result = await repo.miniProjects.publishAssignment(
        req.params.id,
        req.user.sub,
        dueAt
      );

      if (!result || result.count === 0) {
        const assignment = await repo.miniProjects.findAssignmentById(
          req.params.id
        );

        if (!assignment) {
          return res.status(404).json({
            error: "Mini project assignment not found.",
          });
        }

        const student = await repo.users.findById(req.user.sub);

        if (!student) {
          return res.status(404).json({
            error: "Student not found.",
          });
        }

        if (student.domain_role_id !== assignment.domain_role_id) {
          return res.status(403).json({
            error: "You are not authorized to access this mini project.",
          });
        }

        if (assignment.educator?.id !== req.user.sub) {
          return res.status(403).json({
            error: "You are not authorized to publish this assignment.",
          });
        }

        return res.status(409).json({
          error: "Only draft assignments can be published.",
        });
      }

      const assignment = await repo.miniProjects.findAssignmentById(
        req.params.id
      );

      return res.json(assignment);
    } catch (err) {
      next(err);
    }
  }
);

router.get( "/", authRequired, roleRequired("educator"), 
  permissionRequired("mini-projects:view"), async (req, res, next) => {
    try {
      const assignments =
        await repo.miniProjects.listAssignmentsByEducator(
          req.user.sub
        );

      return res.json(assignments);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/mini-projects/current:
 *   get:
 *     tags: [Mini Projects]
 *     summary: Get the current mini project assigned to the student
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current mini project
 *       404:
 *         description: No mini project available
 */
router.get( "/current", authRequired, roleRequired("student"), permissionRequired("mini-projects:view"), async (req, res, next) => {
    try {
      const user = await repo.users.findById(req.user.sub);

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      if (!user.domain_role_id) {
        return res.status(400).json({
          error: "Student does not have a domain role.",
        });
      }

      const assignment = await repo.miniProjects.getCurrentForStudent(
        req.user.sub,
        user.domain_role_id
      );

      if (!assignment) {
        return res.status(404).json({
          error: "No mini project is currently available.",
        });
      }

      return res.json(assignment);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/mini-projects/{id}/submissions:
 *   get:
 *     tags: [Mini Projects]
 *     summary: List the current student's submissions for a mini project
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Student submissions
 */
router.get( "/:id/submissions", authRequired, roleRequired("student"), permissionRequired("mini-projects:view"), async (req, res, next) => {
    try {
      const assignment = await repo.miniProjects.findAssignmentById(
        req.params.id
      );

      if (!assignment) {
        return res.status(404).json({
          error: "Mini project assignment not found.",
        });
      }

      const student = await repo.users.findById(req.user.sub);

      if (!student) {
        return res.status(404).json({
          error: "Student not found."
        });
      }

      if (student.domain_role_id !== assignment.domain_role_id) {
        return res.status(403).json({
          error: "You are not authorized to access this mini project."
        });
      }
      const submissions = await repo.miniProjects.listStudentSubmissions(
        req.params.id,
        req.user.sub
      );

      const submissionsWithAnalysis = await Promise.all(
        submissions.map(async (submission) => {
          const analysis = await repo.miniProjects.getAnalysisBySubmissionId(
            submission.id
          );

          return {
            ...submission,
            analysis,
          };
        })
      );

      return res.json(submissionsWithAnalysis);
      
    } catch (err) {
      next(err);
    }
  }
);

router.post( "/:id/submissions", authRequired, roleRequired("student"),
  permissionRequired("mini-projects:submit"),
  async (req, res, next) => {
    try {
      const assignmentId = req.params.id;
      const studentId = req.user.sub;

      const { repository_url, branch } = req.body || {};

      // ---------------------------------------------------------
      // Validate required fields
      // ---------------------------------------------------------

      if (!repository_url || typeof repository_url !== "string") {
        return res.status(400).json({
          error: "repository_url is required.",
        });
      }

      if (repository_url.length > 500) {
        return res.status(400).json({
          error: "repository_url must not exceed 500 characters.",
        });
      }

      const normalizedBranch =
        typeof branch === "string" && branch.trim()
          ? branch.trim()
          : "main";

      if (normalizedBranch.length > 255) {
        return res.status(400).json({
          error: "branch must not exceed 255 characters.",
        });
      }

      // ---------------------------------------------------------
      // Validate assignment
      // ---------------------------------------------------------

      const assignment =
        await repo.miniProjects.findAssignmentById(assignmentId);

      if (!assignment) {
        return res.status(404).json({
          error: "Mini project assignment not found.",
        });
      }

      if (assignment.status !== "PUBLISHED") {
        return res.status(409).json({
          error: "This mini project is not currently accepting submissions.",
        });
      }

      // ---------------------------------------------------------
      // Validate student
      // ---------------------------------------------------------

      const student = await repo.users.findById(studentId);

      if (!student) {
        return res.status(404).json({
          error: "Student not found.",
        });
      }

      if (!student.domain_role_id) {
        return res.status(400).json({
          error: "Student is not associated with a domain role.",
        });
      }

      if (student.domain_role_id !== assignment.domain_role_id) {
        return res.status(403).json({
          error:
            "This mini project is not assigned to your selected domain role.",
        });
      }

      // ---------------------------------------------------------
      // Enforce one submission per student
      // ---------------------------------------------------------

      const existingSubmission =
        await repo.miniProjects.findSubmissionByAssignmentAndStudent(
          assignmentId,
          studentId
        );

      if (existingSubmission) {
        return res.status(409).json({
          error:
            "You have already submitted this mini project. Further submissions are not allowed.",
        });
      }

      // ---------------------------------------------------------
      // Validate GitHub repository + resolve commit
      // ---------------------------------------------------------

      const githubRepository = await validateRepository(
        repository_url,
        normalizedBranch
      );

      // ---------------------------------------------------------
      // Persist submission
      // ---------------------------------------------------------

      const submission = await repo.miniProjects.createSubmission({
        assignmentId,
        studentId,
        repositoryUrl: githubRepository.repository_url,
        branch: githubRepository.branch,
        commitSha: githubRepository.commit_sha,
      });

      return res.status(201).json({
        success: true,
        data: submission,
      });
    } catch (err) {
      // Database-level protection for concurrent duplicate requests.
      if (
        err?.code === "P2002" &&
        Array.isArray(err?.meta?.target) &&
        err.meta.target.includes("assignment_id") &&
        err.meta.target.includes("student_id")
      ) {
        return res.status(409).json({
          error:
            "You have already submitted this mini project. Further submissions are not allowed.",
        });
      }

      next(err);
    }
  }
);

module.exports = router;