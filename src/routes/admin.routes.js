const express = require("express");
const repo = require("../data");
const { authRequired, permissionRequired } = require("../middleware/auth");
const aimlClient = require("../services/aimlClient");
const { clerkClient } = require("@clerk/express");
const { isValidSubscriptionPlan } = require("../config/subscriptionPlans");

const router = express.Router();
const fs = require("fs");
const path = require("path");

const stripPwd = (user) => {
  if (!user) return user;

  const { password_hash, ...safeUser } = user;
  return safeUser;
};

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List all users (filterable by role / status / search)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of users
 */
router.get(
  "/users",
  authRequired,
  permissionRequired("users:list"),
  async (req, res, next) => {
    try {
      const users = await repo.users.list({
        role: req.query.role || undefined,
        status: req.query.status || undefined,
        q: req.query.q || undefined,
      });

      return res.json(users.map(stripPwd));

    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/admin/users/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Update a user
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Admin]
 *     summary: Delete a user
 *     security:
 *       - bearerAuth: []
 */
router.patch(
  "/users/:id",
  authRequired,
  permissionRequired("users:update"),
  async (req, res, next) => {
    try {
      const user = await repo.users.findById(req.params.id);

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      const allowed = ["name", "role", "status"];
      const data = {};

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          data[key] = req.body[key];
        }
      }

      if (
        data.role &&
        !["student", "educator", "employer", "admin"].includes(data.role)
      ) {
        return res.status(400).json({
          error: "Invalid role.",
        });
      }

      if (
        data.status &&
        !["active", "suspended"].includes(data.status)
      ) {
        return res.status(400).json({
          error: "Invalid status.",
        });
      }

      // Prevent admin from removing their own admin role
      if (
        req.params.id === req.user.sub &&
        data.role &&
        data.role !== "admin"
      ) {
        return res.status(400).json({
          error: "You cannot remove your own admin role.",
        });
      }

      const updatedUser = await repo.users.update(
        req.params.id,
        data
      );

      return res.json(stripPwd(updatedUser));

    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/users/:id",
  authRequired,
  permissionRequired("users:delete"),
  async (req, res, next) => {
    try {
      if (req.params.id === req.user.sub) {
        return res.status(400).json({
          error: "You cannot delete your own account.",
        });
      }

      const user = await repo.users.findById(req.params.id);

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

console.log(
  `[ADMIN] Deleting user ${user.id}, clerk_id: ${user.clerk_id}`
);

           // Mark the Clerk account as deleted before removing the PostgreSQL user
if (user.clerk_id) {
  try {
    await clerkClient.users.updateUserMetadata(user.clerk_id, {
      unsafeMetadata: {
        ...(await clerkClient.users.getUser(user.clerk_id)).unsafeMetadata,
        account_status: "deleted",
      },
    });

    console.log(
      `[ADMIN] Marked Clerk account as deleted: ${user.clerk_id}`
    );
  } catch (clerkErr) {
    console.error(
      "[ADMIN] Failed to mark Clerk account as deleted:",
      clerkErr.message
    );

    return res.status(500).json({
      error: "Could not delete user safely because the Clerk account could not be updated.",
    });
  }
}

await repo.users.remove(req.params.id);

return res.status(204).end();

    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/recent-activity",
  authRequired,
  permissionRequired("admin:insights"),
  async (req, res, next) => {
    try {
      const requestedLimit = Number(req.query?.limit);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 20)
        : 10;

      const activities = await repo.adminRecentActivity(limit);

      return res.json({
        activities,
        total: activities.length,
      });
    } catch (err) {
      next(err);
    }
  }
);


/**
 * @openapi
 * /api/admin/insights:
 *   get:
 *     tags: [Admin]
 *     summary: AI insights hub
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Insights object
 */
router.get(
  "/insights",
  authRequired,
  permissionRequired("admin:insights"),
  async (req, res, next) => {
    try {
      const insights = await repo.insights();

      return res.json(insights);

    } catch (err) {
      next(err);
    }
  }
);




/**
 * @openapi
 * /api/admin/analytics/dropout-risk/{studentId}:
 *   get:
 *     tags: [Admin]
 *     summary: AI prediction of dropout risk for a student
 *     security:
 *       - bearerAuth: []
 */
router.get(
  "/analytics/dropout-risk/:studentId",
  authRequired,
  permissionRequired("admin:insights"), // or appropriate permission
  async (req, res, next) => {
    try {
      const studentId = req.params.studentId;
      const enrollments = (await repo.enrollments.listByUser(studentId)) || [];
      const completedCount = enrollments.filter(
        (e) => e.status === "completed" || e.completed
      ).length;
      const completionPercentage =
        enrollments.length > 0
          ? Math.round((completedCount / enrollments.length) * 100)
          : 50.0;

      const studentData = {
        student_id: studentId,
        sessions_last_30_days: Math.max(enrollments.length * 4, 8),
        avg_session_minutes: 45.0,
        videos_watched: Math.max(enrollments.length * 3, 6),
        assignments_attempted: Math.max(completedCount, 3),
        discussion_interactions: 3,
        logins_last_30_days: 12,
        days_since_last_login: 2,
        completion_percentage: completionPercentage,
        quiz_average: 75.0,
        assignment_completion_rate: completionPercentage,
      };

      try {
        const aiData = await aimlClient.predictDropout(studentData);
        return res.json(aiData);
      } catch (aiErr) {
        return res.status(502).json({ error: "AI Dropout Prediction failed", details: aiErr.message });
      }

    } catch (err) {
      next(err);
    }
  }
);



router.get(
  "/subscriptions",
  authRequired,
  permissionRequired("subscriptions:view-all"),
  async (req, res, next) => {
    try {
      const subscriptions = await repo.subscriptions.listAll();
      return res.json(subscriptions);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/subscriptions/summary",
  authRequired,
  permissionRequired("subscriptions:view-all"),
  async (req, res, next) => {
    try {
      const summary = await repo.subscriptions.summary();
      return res.json(summary);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Admin subscription management
 *
 * Admin can:
 * - Change an existing subscription plan
 * - Extend an existing subscription
 */

router.patch(
  "/subscriptions/:id/plan",
  authRequired,
  permissionRequired("subscriptions:manage"),
  async (req, res, next) => {
    try {
      const { plan_type } = req.body || {};

      if (!plan_type) {
        return res.status(400).json({
          error: "plan_type is required.",
        });
      }

      if (!isValidSubscriptionPlan(plan_type)) {
        return res.status(400).json({
          error: "Invalid subscription plan.",
        });
      }

      const subscription = await repo.subscriptions.updatePlan(
        req.params.id,
        plan_type
      );

      return res.json(subscription);
    } catch (err) {
      if (err.message === "Subscription not found.") {
        return res.status(404).json({ error: err.message });
      }

      next(err);
    }
  }
);

router.patch(
  "/subscriptions/:id/extend",
  authRequired,
  permissionRequired("subscriptions:manage"),
  async (req, res, next) => {
    try {
      const { months } = req.body || {};

      if (!Number.isInteger(months) || months < 1 || months > 36) {
        return res.status(400).json({
          error: "months must be an integer between 1 and 36.",
        });
      }

      const subscription = await repo.subscriptions.extend(
        req.params.id,
        months
      );

      return res.json(subscription);
    } catch (err) {
      if (err.message === "Subscription not found.") {
        return res.status(404).json({ error: err.message });
      }

      next(err);
    }
  }
);




/**
 * Assessment termination reports
 *
 * Admin can:
 * - List submitted assessment reports
 * - View a single report with termination evidence
 * - Resolve/update a report
 */

router.get(
  "/assessment-reports",
  authRequired,
  permissionRequired("reports:view"),
  async (req, res, next) => {
    try {
      const status = req.query.status || null;

      const reports = await repo.assessmentReports.list(status);

      return res.json(reports);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/assessment-reports/:id",
  authRequired,
  permissionRequired("reports:view"),
  async (req, res, next) => {
    try {
      const reportId = Number(req.params.id);

      if (!Number.isInteger(reportId)) {
        return res.status(400).json({
          error: "Invalid report ID.",
        });
      }

      const report = await repo.assessmentReports.findById(reportId);

      if (!report) {
        return res.status(404).json({
          error: "Assessment report not found.",
        });
      }

      return res.json(report);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/assessment-reports/:id",
  authRequired,
  permissionRequired("reports:view"),
  async (req, res, next) => {
    try {
      const reportId = Number(req.params.id);

      if (!Number.isInteger(reportId)) {
        return res.status(400).json({
          error: "Invalid report ID.",
        });
      }

      const { status, admin_notes } = req.body;

      const allowedStatuses = [
        "Pending",
        "Under Review",
        "Approved",
        "Rejected",
      ];

      if (!status || !allowedStatuses.includes(status)) {
        return res.status(400).json({
          error: `Status must be one of: ${allowedStatuses.join(", ")}`,
        });
      }

      const existingReport =
        await repo.assessmentReports.findById(reportId);

      if (!existingReport) {
        return res.status(404).json({
          error: "Assessment report not found.",
        });
      }

      const report = await repo.assessmentReports.update(reportId, {
        status,
        admin_notes:
          admin_notes !== undefined
            ? String(admin_notes).trim() || null
            : existingReport.admin_notes,
        admin_id: req.user.sub,
        resolved_at:
          status === "Approved" || status === "Rejected"
            ? new Date()
            : null,
      });

      return res.json({
        message: "Assessment report updated successfully.",
        report,
      });
    } catch (err) {
      next(err);
    }
  }
);


/**
 * @openapi
 * /api/admin/subscriptions:
 *   get:
 *     tags: [Admin]
 *     summary: List all subscriptions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of subscriptions
 */

router.get(
  "/assessment-reports/:id/evidence",
  authRequired,
  permissionRequired("reports:view"),
  async (req, res, next) => {
    try {
      const reportId = Number(req.params.id);

      if (!Number.isInteger(reportId)) {
        return res.status(400).json({
          error: "Invalid report ID.",
        });
      }

      const report = await repo.assessmentReports.findById(reportId);

      if (!report) {
        return res.status(404).json({
          error: "Assessment report not found.",
        });
      }

      if (!report.evidence) {
        return res.status(404).json({
          error: "No evidence file was uploaded.",
        });
      }

      const evidenceDirectory = path.resolve(
        __dirname,
        "../../assessment-evidence"
      );

      const fileName = path.basename(report.evidence);
      const filePath = path.join(evidenceDirectory, fileName);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: "Evidence file not found.",
        });
      }

      return res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  }
);



module.exports = router;