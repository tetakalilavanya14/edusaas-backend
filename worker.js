// Load environment configuration (same resolution as server.js)
const { appEnv } = require("./src/config/env");

const {
  processQueuedAnalyses,
  recoverStuckAnalyses,
} = require("./src/services/miniProjectAnalysisWorker");

const ANALYSIS_WORKER_INTERVAL_MS =
  Number(process.env.ANALYSIS_WORKER_INTERVAL_MS) || 10 * 1000;
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

console.log(
  `[miniProjectAnalysisWorker] Worker started (APP_ENV=${appEnv}, pollInterval=${ANALYSIS_WORKER_INTERVAL_MS}ms)`
);

let isCycleRunning = false;
let isShuttingDown = false;

async function runWorkerCycle() {
  if (isCycleRunning || isShuttingDown) {
    return;
  }

  isCycleRunning = true;

  try {
    const result = await processQueuedAnalyses();

    if (result.found > 0) {
      console.log(
        `[miniProjectAnalysisWorker] found=${result.found} processed=${result.processed} failed=${result.failed}`
      );
    }
  } catch (error) {
    console.error(
      "[miniProjectAnalysisWorker] Worker cycle failed:",
      error.message
    );
  } finally {
    isCycleRunning = false;
  }
}

// Run initial cycle on startup
runWorkerCycle();

// Schedule periodic polling loop
const pollIntervalId = setInterval(
  runWorkerCycle,
  ANALYSIS_WORKER_INTERVAL_MS
);

// Run initial recovery on startup, then periodically
recoverStuckAnalyses();
const recoveryIntervalId = setInterval(
  () => recoverStuckAnalyses(),
  RECOVERY_INTERVAL_MS
);

// Graceful shutdown handling
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(
    `[miniProjectAnalysisWorker] Received ${signal}. Shutting down gracefully...`
  );

  clearInterval(pollIntervalId);
  clearInterval(recoveryIntervalId);

  const maxWaitMs = 15000;
  const startTime = Date.now();

  const shutdownInterval = setInterval(() => {
    if (!isCycleRunning || Date.now() - startTime >= maxWaitMs) {
      clearInterval(shutdownInterval);
      console.log("[miniProjectAnalysisWorker] Worker stopped.");
      process.exit(0);
    }
  }, 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
