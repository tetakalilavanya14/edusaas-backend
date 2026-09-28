// src/services/aimlClient.js

const { aimlServiceUrl } = require("../config/env");
const crypto = require("crypto");

/**
 * Converts a string ID (like a Clerk user_2Q...) into a stable positive Integer
 */
function clerkToInt(clerkId) {
  if (!clerkId) return 1;
  const hash = crypto.createHash("md5").update(String(clerkId)).digest("hex");
  return parseInt(hash.substring(0, 8), 16) & 0x7FFFFFFF;
}

/**
 * Converts a string ID into a valid UUID v4 format
 */
function clerkToUUID(clerkId) {
  if (!clerkId) return "00000000-0000-0000-0000-000000000000";
  const str = String(clerkId);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(str)) {
    return str;
  }
  const hash = crypto.createHash("md5").update(str).digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    hash.substring(12, 16),
    hash.substring(16, 20),
    hash.substring(20, 32),
  ].join("-");
}

/**
 * Helper to make requests to the unified AIML FastAPI Service
 */
async function callAIML(
  endpoint,
  payload = null,
  method = "POST",
  customBaseUrl = null
) {
  const controller = new AbortController();

  // Prevent a slow/unavailable AIML service from blocking
  // the main application request indefinitely.
  const timeout = setTimeout(() => {
    controller.abort();
  }, 5000);

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    signal: controller.signal,
  };

  if (payload && method !== "GET") {
    options.body = JSON.stringify(payload);
  }

  try {
    const baseUrl = customBaseUrl || aimlServiceUrl;
    const response = await fetch(`${baseUrl}${endpoint}`, options);

    let data;

    try {
      data = await response.json();
    } catch (err) {
      const error = new Error(
        "AI service returned a non-JSON response"
      );
      error.status = 502;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(
        data.detail ||
        data.message ||
        "AI service failed"
      );
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(
        `[AIML Client Timeout] ${endpoint}: AI service did not respond within 5 seconds`
      );
    } else {
      console.error(
        `[AIML Client Error] ${endpoint}:`,
        error.message
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// 1. Dropout & Attrition Risk
// ---------------------------------------------------------------------
async function predictDropout(studentData) {
  const payload = {
    ...studentData,
    student_id: clerkToUUID(studentData.student_id),
  };
  return callAIML("/api/dropout/predict", payload, "POST");
}

// ---------------------------------------------------------------------
// 2. Course Recommendations
// ---------------------------------------------------------------------
async function getRecommendations(param1, param2, param3) {
  let userId, courseName, courses, ratings, user, prerequisites, completedCourses;
  if (typeof param1 === "object" && param1 !== null) {
    ({
      userId,
      courseName,
      courses = [],
      ratings = [],
      user = null,
      prerequisites = [],
      completedCourses = [],
    } = param1);
  } else {
    userId = param1;
    courseName = param2;
    courses = param3 || [];
  }

  const payload = {
    user_id: clerkToUUID(userId),
    course_name: courseName || "Machine Learning",
    courses: courses || [],
    ratings: ratings || [],
    user: user || null,
    prerequisites: prerequisites || [],
    completed_courses: completedCourses || [],
  };
  return callAIML("/api/recommendation/recommend", payload, "POST");
}

// ---------------------------------------------------------------------
// 3. Predictive Hiring Candidate Match
// ---------------------------------------------------------------------
async function predictHiring(hiringData) {
  const payload = {
    experience_years: Number(hiringData.experience_years || 0),
    required_experience_years: Number(hiringData.required_experience_years || 0),
    skill_match_score: Number(hiringData.skill_match_score || 0),
    experience_match_score: Number(hiringData.experience_match_score || 0),
    domain_match: Number(hiringData.domain_match ? 1 : 0),
    profile_score: Number(hiringData.profile_score || 0),
  };
  return callAIML("/api/hiring/predict", payload, "POST");
}

// ---------------------------------------------------------------------
// 4. Code Plagiarism Detection
// ---------------------------------------------------------------------
async function checkCodePlagiarism(payload) {
  // payload: { language, submission: { submission_id, code }, comparison_submissions: [{ submission_id, code }] }
  try {
    return await callAIML("/api/plagiarism/api/plagiarism/check", payload, "POST");
  } catch (err) {
    // Fallback if mounted without prefix duplication
    return await callAIML("/api/plagiarism/check", payload, "POST");
  }
}


// ---------------------------------------------------------------------
// 5. Descriptive Answer Evaluation (XLNet)
// ---------------------------------------------------------------------
async function evaluateDescriptiveAnswer({ questionText, studentAnswerText, referenceAnswerText }) {
  const payload = {
    question_text: String(questionText || "").trim(),
    student_answer_text: String(studentAnswerText || "").trim(),
    reference_answer_text: String(referenceAnswerText || "").trim(),
  };
  return callAIML("/api/evaluation/evaluate", payload, "POST");
}

// ---------------------------------------------------------------------
// 6. Fraud & Integrity Detection
// ---------------------------------------------------------------------
async function predictFraud(fraudData) {
  if (fraudData.student_id) fraudData.student_id = clerkToInt(fraudData.student_id);
  return callAIML("/fraud/predict", fraudData, "POST");
}

// ---------------------------------------------------------------------
// 7. Community Sentiment & Toxicity
// ---------------------------------------------------------------------
async function analyzeSentiment(postData) {
  if (postData.student_id) postData.student_id = clerkToInt(postData.student_id);
  return callAIML("/sentiment/predict-sentiment", postData, "POST");
}

async function analyzeToxicity(postData) {
  if (postData.student_id) postData.student_id = clerkToInt(postData.student_id);
  return callAIML("/toxicity/predict", postData, "POST");
}

module.exports = {
  callAIML,
  clerkToUUID,
  clerkToInt,
  predictDropout,
  getRecommendations,
  predictHiring,
  checkCodePlagiarism,
  evaluateDescriptiveAnswer,
  predictFraud,
  analyzeSentiment,
  analyzeToxicity,
};
