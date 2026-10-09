// flaskServices.js
//
// Thin HTTP client for the Python (Flask) adaptive-quiz engine.
// This layer has ZERO database awareness — it only forwards state/question
// payloads to Python and returns whatever Python computes. All persistence
// happens in assessmentService.js using the Prisma repo.
//
// IMPORTANT: AIML_BASE_URL must point at wherever `python app.py` is
// actually running. Flask's default (app.run(debug=True)) is port 5001.
// Either set FLASK_QUIZ_URL=http://127.0.0.1:5001 in your .env, or change
// app.run(port=5001) on the Python side — just make sure they match.

const { flaskQuizUrl, aimlTimeoutMs } = require("../config/env");

async function callFlask(endpoint, payload) {
  const controller = new AbortController();
  const timeoutLimit = aimlTimeoutMs || 45000;
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutLimit);

  try {
    const response = await fetch(`${flaskQuizUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let data;
    try {
      data = await response.json();
    } catch (err) {
      const error = new Error("AI service returned a non-JSON response");
      error.status = 502;
      throw error;
    }

    if (!response.ok || data.success === false) {
      const error = new Error(data.message || "AI service failed");
      error.status = response.status >= 400 ? response.status : 502;
      throw error;
    }

    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      const error = new Error(`AI service did not respond within ${timeoutLimit}ms`);
      error.status = 504;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Adaptive quiz engine — /api/quiz/*
// ---------------------------------------------------------------------

// state: { session_id, skill: { skill_id, skill_name } }
async function createQuizState(payload) {
  return callFlask("/api/quiz/create-state", payload);
}

// { state, questions } -> { question }
async function getNextQuestion(payload) {
  return callFlask("/api/quiz/next-question", payload);
}

// { state, question, selected_option } -> { result: { is_correct, marks_awarded, skill_completed, updated_state } }
async function submitAnswer(payload) {
  return callFlask("/api/quiz/submit-answer", payload);
}

// { state } -> { result: { obtained_score, maximum_score, percentage, skill_level, ... } }
async function calculateSkillScore(payload) {
  return callFlask("/api/quiz/calculate-score", payload);
}

// { skills, current_skill_index } -> { result }
// Not currently used by assessmentService (skill order is driven by
// domainRequiredSkills instead), but exposed for completeness.
async function getNextSkill(payload) {
  return callFlask("/api/quiz/next-skill", payload);
}

// { state } -> { result: { assessment_completed, completed_skill } }
async function finishQuiz(payload) {
  return callFlask("/api/quiz/finish", payload);
}


// ---------------------------------------------------------------------
// Skill gap engine — /api/skill-gap/*
// ---------------------------------------------------------------------

// { student_skills: [{skill_id, skill_level}], required_skills: [{skill_id, required_level, skill_name}] }
// -> { result: { skill_gap, readiness_score, missing_skills } }

async function analyzeSkillGap(payload) {
  return callFlask("/api/skill-gap/analyze", payload)
}


module.exports = {
  createQuizState,
  getNextQuestion,
  submitAnswer,
  calculateSkillScore,
  getNextSkill,
  finishQuiz,
  analyzeSkillGap,
};