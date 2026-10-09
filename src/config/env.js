// Loads environment variables.
// Resolution order:
//   1) If APP_ENV is set (e.g. dev, stage, prod), load `.env.<APP_ENV>` first.
//   2) Then load the default `.env` to fill in any missing values.
//
// This lets you keep one `.env` per environment without juggling files.
const path = require("path");

const APP_ENV = (process.env.APP_ENV || "").trim().toLowerCase();

if (APP_ENV) {
  require("dotenv").config({
    path: path.join(__dirname, "..", "..", `.env.${APP_ENV}`),
  });
}
// Always load .env last as a fallback; existing env vars won't be overridden.
require("dotenv").config();


const rawAimlUrl = (
  process.env.AIML_SERVICE_URL ||
  process.env.AIML_BASE_URL ||
  "https://edusaas-aiml-parb.onrender.com"
).trim().replace(/\/+$/, "");

const rawFraudWs = (
  process.env.FRAUD_AI_WS_URL ||
  (rawAimlUrl.startsWith("https://")
    ? rawAimlUrl.replace("https://", "wss://") + "/ws/proctor"
    : rawAimlUrl.startsWith("http://")
    ? rawAimlUrl.replace("http://", "ws://") + "/ws/proctor"
    : "ws://127.0.0.1:10000/ws/proctor")
).trim();

module.exports = {
  appEnv: APP_ENV || "default",
  port: parseInt(process.env.PORT, 10) || 5000,

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "1h",

  refreshJwtSecret: process.env.JWT_REFRESH_SECRET,

  refreshJwtExpiresIn:
    process.env.JWT_REFRESH_EXPIRES_IN || "7d",

  databaseUrl: process.env.DATABASE_URL || "",

  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "",

  aimlServiceUrl: rawAimlUrl,
  fraudAiWsUrl: rawFraudWs,
  plagiarismBaseUrl: rawAimlUrl,
  flaskQuizUrl: rawAimlUrl,
  aimlTimeoutMs: parseInt(process.env.AIML_TIMEOUT_MS, 10) || 45000,
};
