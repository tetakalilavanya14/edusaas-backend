// Import required modules
const express = require("express");
const cors = require("cors");
const path = require("path");
const swaggerUi = require("swagger-ui-express");

// Import environment variables and Swagger configuration
const { port, appEnv } = require("./src/config/env");
const swaggerSpec = require("./src/config/swagger");

// Import route handlers
const authRoutes = require("./src/routes/auth.routes");
const usersRoutes = require("./src/routes/users.routes");
const assessmentsRoutes = require("./src/routes/assessments.routes");
const assessmentReportsRoutes = require("./src/routes/assessmentReports.routes");
const gapReportRoutes = require("./src/routes/gapReport.routes");
const skillGapAnalysisRoutes = require("./src/routes/skillgapanalysis.routes");
const coursesRoutes = require("./src/routes/courses.routes");
const enrollmentsRoutes = require("./src/routes/enrollments.routes");
const jobsRoutes = require("./src/routes/jobs.routes");
const notificationsRoutes = require("./src/routes/notifications.routes");
const adminRoutes = require("./src/routes/admin.routes");
const subscriptionsRoutes = require("./src/routes/subscriptions.routes");
const subscriptionPlansRoutes = require("./src/routes/subscriptionPlans.routes");
const reportsRoutes = require("./src/routes/reports.routes");
const settingsRoutes = require("./src/routes/settings.routes");
const lessonsRoutes = require("./src/routes/lessons.routes");
const progressRoutes = require("./src/routes/progress.routes");
const certificatesRoutes = require("./src/routes/certificates.routes");
const achievementsRoutes = require("./src/routes/achievements.routes");
const tasksRoutes = require("./src/routes/tasks.routes");
const recommendationsRoutes = require("./src/routes/recommendations.routes");
const announcementsRoutes = require("./src/routes/announcements.routes");
const dashboardRoutes = require("./src/routes/dashboard.routes");
const rbacRoutes = require("./src/routes/rbac.routes");
const domainRolesRoutes = require("./src/routes/domainRoles.routes");
const communityRoutes = require("./src/routes/community.routes");
const miniProjectRoutes = require("./src/routes/miniProject.routes")

// Import error handling middleware
const { notFound, errorHandler } = require("./src/middleware/errorHandler");
const { attachProctoringGateway } = require("./src/services/proctoringGateway");

// Initialize the Express application
const app = express();

// Enable Cross-Origin Resource Sharing (CORS)
app.use(cors());
// Mount webhooks route BEFORE express.json() so it can use express.raw()
app.use("/api/webhooks", require("./src/routes/webhooks.routes"));

// Parse incoming JSON requests
app.use(express.json());
// Serve uploaded resumes
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);

// Root endpoint to check the status of the service
app.get("/", (req, res) => {
  res.json({
    name: "EDU-SAAS Backend",
    status: "ok",
    docs: "/api-docs",
  });
});


// Platform health check
app.get("/api/health", async (req, res) => {
  const startedAt = Date.now();

  try {
    const database = await repo.health.database();

    const responseTimeMs = Date.now() - startedAt;

    const overallStatus =
      database.status === "ok" ? "ok" : "degraded";

    return res.status(overallStatus === "ok" ? 200 : 503).json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      responseTimeMs,
      services: {
        backend: {
          status: "ok",
        },
        database,
      },
    });
  } catch (error) {
    return res.status(503).json({
      status: "error",
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startedAt,
      services: {
        backend: {
          status: "ok",
        },
        database: {
          status: "error",
        },
      },
    });
  }
});


// Serve Swagger API documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
// Provide the Swagger specification as a JSON file
app.get("/api-docs.json", (req, res) => res.json(swaggerSpec));

// Mount the various API routes
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/connections", require("./src/routes/connections.routes"));
app.use("/api/assessments", assessmentsRoutes);
app.use("/api/assessment-reports", assessmentReportsRoutes);
app.use("/api/gap-report", gapReportRoutes);
app.use("/api/skill-gap-analysis", skillGapAnalysisRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/enrollments", enrollmentsRoutes);
app.use("/api/jobs", jobsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
app.use("/api/subscription-plans", subscriptionPlansRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/domain-roles", domainRolesRoutes);

// Lesson routes are nested under /api/courses for /:id/lessons,
// plus a top-level /api/lessons/lesson/:id for single-lesson detail.
app.use("/api/courses", lessonsRoutes);
app.use("/api/lessons", lessonsRoutes);

app.use("/api/progress", progressRoutes);
app.use("/api/certificates", certificatesRoutes);
app.use("/api/achievements", achievementsRoutes);
app.use("/api/tasks", tasksRoutes);
app.use("/api/recommendations", recommendationsRoutes);
app.use("/api/announcements", announcementsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/rbac", rbacRoutes);
app.use("/api/community", communityRoutes);
app.use("/api/aiml", require("./src/routes/aiml.routes"));
app.use("/api/mini-projects", miniProjectRoutes);

const repo = require("./src/data");
const { authRequired } = require("./src/middleware/auth");

app.get("/api/me/assignments", authRequired, async (req, res, next) => {
  try {
    const enrollments = await repo.enrollments.listByUser(req.user.sub);
    return res.json(enrollments || []);
  } catch (err) {
    next(err);
  }
});

// Middleware to handle 404 Not Found errors
app.use(notFound);
// Centralized error handler
app.use(errorHandler);

// Start the server and listen on the configured port
const server = app.listen(port, () => {
  console.log(`[env] APP_ENV=${appEnv}`);
  console.log(`EDU-SAAS backend running at http://localhost:${port}`);
  console.log(`Swagger docs:           http://localhost:${port}/api-docs`);
});


attachProctoringGateway(server)
