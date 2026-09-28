const express = require("express");
const repo = require("../data");
const { authRequired, permissionRequired } = require("../middleware/auth");

const router = express.Router();

/**
 * @openapi
 * /api/announcements:
 *   get:
 *     tags: [Announcements]
 *     summary: List all announcements (most recent first)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of announcements
 *   post:
 *     tags: [Announcements]
 *     summary: Send an announcement (Educator/Admin)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - message
 *             properties:
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               audience:
 *                 type: string
 *                 enum:
 *                   - all
 *                   - course
 *                   - educators
 *               scheduled_at:
 *                 type: string
 *                 format: date-time
 *               attachment:
 *                 type: string
 *     responses:
 *       201:
 *         description: Announcement created
 */

router.get("/", authRequired, async (req, res, next) => {
  try {
    const allAnnouncements = await repo.announcements.list();

    if (req.user.role === "student") {
      // Find educator IDs for courses this student is actively enrolled in
      const studentEnrollments = await repo.prisma.enrollment.findMany({
        where: { user_id: req.user.sub },
        include: { course: { select: { educator_id: true } } },
      });
      const enrolledEducatorIds = new Set(
        studentEnrollments.map((e) => e.course?.educator_id).filter(Boolean)
      );

      const visible = allAnnouncements.filter((a) => {
        if (a.audience === "all") return true;
        if (a.audience === "course" && enrolledEducatorIds.has(a.educator_id)) return true;
        return false;
      });
      return res.json(visible);
    }

    if (req.user.role === "educator") {
      const visible = allAnnouncements.filter((a) => {
        if (a.educator_id === req.user.sub) return true;
        if (a.audience === "all" || a.audience === "educators") return true;
        return false;
      });
      return res.json(visible);
    }

    return res.json(allAnnouncements);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/",
  authRequired,
  permissionRequired("announcements:send"),
  async (req, res, next) => {
    try {
      const {
        title,
        message,
        audience,
        scheduled_at,
        attachment,
      } = req.body || {};

      if (!title || !message) {
        return res.status(400).json({
          error: "Title and message are required.",
        });
      }

      if (
        audience &&
        !["all", "course", "educators"].includes(audience)
      ) {
        return res.status(400).json({
          error: "Invalid audience.",
        });
      }

      let scheduledDate = null;

      if (scheduled_at) {
        scheduledDate = new Date(scheduled_at);

        if (Number.isNaN(scheduledDate.getTime())) {
          return res.status(400).json({
            error: "Invalid scheduled_at date.",
          });
        }
      }

      const announcement = await repo.announcements.create({
        educator_id: req.user.sub,
        title,
        message,
        audience: audience || "all",
        scheduled_at: scheduledDate,
        attachment: attachment || null,
      });

      // Automatically dispatch in-app bell notifications to target recipients
      try {
        const educatorUser = await repo.prisma.user.findUnique({
          where: { id: req.user.sub },
          select: { name: true },
        });
        const educatorName = educatorUser?.name || "Educator";

        let recipientIds = [];
        if (audience === "course") {
          // Students enrolled in this educator's courses
          const educatorCourses = await repo.prisma.course.findMany({
            where: { educator_id: req.user.sub },
            select: { id: true },
          });
          const courseIds = educatorCourses.map((c) => c.id);
          const enrollments = await repo.prisma.enrollment.findMany({
            where: { course_id: { in: courseIds } },
            select: { user_id: true },
          });
          recipientIds = Array.from(new Set(enrollments.map((e) => e.user_id)));
        } else if (audience === "all") {
          // All active students
          const students = await repo.prisma.user.findMany({
            where: { role: { name: "student" }, status: "active" },
            select: { id: true },
          });
          recipientIds = students.map((s) => s.id);
        } else if (audience === "educators") {
          // Other educators
          const educators = await repo.prisma.user.findMany({
            where: { role: { name: "educator" }, status: "active", id: { not: req.user.sub } },
            select: { id: true },
          });
          recipientIds = educators.map((e) => e.id);
        }

        if (recipientIds.length > 0) {
          await repo.prisma.notification.createMany({
            data: recipientIds.map((userId) => ({
              user_id: userId,
              type: "announcement",
              message: `📣 ${educatorName}: ${title}`,
              reference_id: announcement.id,
              read_status: false,
            })),
          });
        }
      } catch (notifyErr) {
        console.error("Failed to dispatch announcement notifications:", notifyErr);
      }

      return res.status(201).json(announcement);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;