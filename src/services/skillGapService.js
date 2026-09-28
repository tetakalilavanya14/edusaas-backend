

const repo = require("../data");
const {calculateEffectiveReadiness, calculateFinalReadiness} = require("./readinessScoreService")

// ---------------------------------------------------------------------
// Empty report returned when the student has not completed the initial
// assignment yet — empty arrays instead of an error, so the frontend can
// render an empty state and reload automatically once the assessment is
// completed (the report is then regenerated).
// ---------------------------------------------------------------------
function buildEmptyGapReport(userId) {
  return {
    id: null,
    user_id: userId,
    readiness_score: 0,
    missing_skills: [],
    recommendations: {
      skill_gap: [],
      suggestions: [],
    },
    created_at: null,
    updated_at: null,
  };
}

// ---------------------------------------------------------------------
// Pure in-memory calculation of student's skill gap & readiness score.
// Replaces external Python call with native 1ms Node.js computation.
// ---------------------------------------------------------------------
function computeSkillGap(studentSkills, requiredSkills) {
  const report = [];
  const missingSkills = [];
  let totalStudent = 0;
  let totalRequired = 0;

  const studentMap = new Map();
  for (const skill of studentSkills) {
    studentMap.set(skill.skill_id, skill);
  }

  for (const required of requiredSkills) {
    const skillId = required.skill_id;
    const requiredLevel = required.required_level || 0;
    const skillName = required.skill_name || "";
    const studentData = studentMap.get(skillId) || {};
    const studentLevel = studentData.skill_level || 0;

    let gap = requiredLevel - studentLevel;
    if (gap < 0) gap = 0;

    let status;
    if (gap === 0) {
      status = "Ready";
    } else {
      status = "Needs Improvement";
      missingSkills.push(skillName);
    }

    report.push({
      skill_id: skillId,
      skill_name: skillName,
      required_level: requiredLevel,
      student_level: studentLevel,
      gap,
      status,
    });

    const effectiveStudentLevel = Math.min(studentLevel, requiredLevel);
    totalStudent += effectiveStudentLevel;
    totalRequired += requiredLevel;
  }

  const readinessScore =
    totalRequired === 0
      ? 0
      : Math.round((totalStudent / totalRequired) * 10000) / 100;

  return {
    skill_gap: report,
    readiness_score: readinessScore,
    missing_skills: missingSkills,
  };
}

// ---------------------------------------------------------------------
// Generate (or regenerate) a student's skill gap report.
//
// Flow: Assessment Completed -> Load Student Skill Results ->
//       Load Required Skills -> Native Skill Gap Engine ->
//       Compare Required vs Student Skill Levels -> Calculate Skill Gap ->
//       Calculate Readiness Score -> Identify Missing Skills ->
//       Generate Skill Gap Report (persisted to gap_reports)
// ---------------------------------------------------------------------
async function generateGapReport(userId, { readinessScore } = {}) {
  // 1. Student + domain
  const user = await repo.users.findById(userId);

  if (!user) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }

  if (!user.domain_role_id) {
    const allRoles = (await repo.domainRoles.list()) || [];
    const aiRole = allRoles.find((r) => r.domain_name === "AI Engineer") || allRoles[0];
    if (aiRole) {
      await repo.users.update(userId, {
        domain_role_id: aiRole.domain_role_id || aiRole.id,
      });
      user.domain_role_id = aiRole.domain_role_id || aiRole.id;
    } else {
      const error = new Error("Student has not selected a domain role");
      error.status = 400;
      throw error;
    }
  }

  // 2. Skills required for the domain (with required_level)
  const requiredSkills = await repo.domainRequiredSkills.findByDomainRoleId(
    user.domain_role_id
  );

  if (!requiredSkills.length) {
    const error = new Error("No skills configured for the selected domain");
    error.status = 404;
    throw error;
  }

  // 3. Student's most recent completed assessment
  const completedSession = await repo.quizSessions.findCompletedByUser( userId, "INITIAL");

  if (!completedSession) {
    // Initial assignment not completed yet — return an empty report
    // (no error) so the frontend shows empty data until the assessment
    // is done, then it loads automatically.
    return buildEmptyGapReport(userId);
  }

  // 4. Per-skill results from that session
  const skillResults = await repo.studentSkillResults.findBySessionId(
    completedSession.session_id
  );

  // 5. Build the payload
  const studentSkillsPayload = skillResults.map((r) => ({
    skill_id: r.skill_id,
    skill_name: r.skill?.skill_name || "",
    skill_level: r.skill_level,
  }));

  const requiredSkillsPayload = requiredSkills.map((rs) => ({
    skill_id: rs.skill_id,
    skill_name: rs.skill?.skill_name || "",
    required_level: rs.required_level,
  }));

  // 6. Native Node computation — runs in ~0.5ms with 100% reliability
  const analysis = computeSkillGap(
    studentSkillsPayload,
    requiredSkillsPayload
  );

  // 7. Build what we persist (see schema note above)
  const recommendations = {
    skill_gap: analysis.skill_gap,
    suggestions: analysis.missing_skills.map((skillName) => ({
      skill: skillName,
      suggestion: `Focus on improving ${skillName} to meet the required level.`,
    })),
  };

  const existingReport = await repo.gapReports.findByUserId(userId);

  // 8. Preserve assessment-derived readiness scores.
  // The native skill-gap calculation is used only for skill-gap analysis
  // and must not overwrite Initial/Final assessment readiness.
  const preservedInitialReadiness =
    readinessScore ??
    existingReport?.initial_readiness_score ??
    analysis.readiness_score;

  const preservedFinalReadiness =
    existingReport?.final_readiness_score ?? null;

  const effectiveReadiness =
    preservedFinalReadiness == null
      ? preservedInitialReadiness
      : Math.max(
          preservedInitialReadiness,
          preservedFinalReadiness
        );

  const report = await repo.gapReports.upsert(userId, {
    readiness_score: Number(effectiveReadiness.toFixed(2)),
    initial_readiness_score:
      Number(preservedInitialReadiness.toFixed(2)),
    final_readiness_score:
      preservedFinalReadiness == null
        ? null
        : Number(preservedFinalReadiness.toFixed(2)),
    missing_skills: analysis.missing_skills,
    recommendations,
  });

  return report;
}

async function getSkillGapAnalysis(userId) {
  const user = await repo.users.findById(userId);

  if (!user) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }

  if (!user.domain_role_id) {
    const error = new Error("Student has not selected a domain role");
    error.status = 400;
    throw error;
  }

  const quizSession = await repo.quizSessions.findLatestByUserAndAssessmentType(
    userId,
    "INITIAL"
  );

  if (!quizSession || quizSession.status !== "Completed") {
    // Initial assignment not completed yet — frontend shows empty data
    // until the assessment is done, then it loads automatically.
    return {
      userId,
      domainRole: user.domainRole
        ? {
            id: user.domainRole.domain_role_id,
            name: user.domainRole.domain_name,
          }
        : { id: user.domain_role_id },
      quiz: null,
      codingAssessment: null,
      skills: [],
    };
  }

  const codingSession = await repo.codingSessions.findBySessionAndUser(
    quizSession.session_id,
    userId
  );

  if (!codingSession || codingSession.status !== "Completed") {
    // Coding part of the initial assignment still pending.
    const latestSession = await repo.quizSessions.findLatestByUserAndAssessmentType(
      userId,
      "INITIAL"
    );

    return {
      userId,
      domainRole: latestSession?.domainRole
        ? {
            id: latestSession.domainRole.domain_role_id,
            name: latestSession.domainRole.domain_name,
          }
        : { id: user.domain_role_id },
      quiz: {
        sessionId: latestSession?.session_id ?? quizSession.session_id,
        percentage: 0,
      },
      codingAssessment: null,
      skills: [],
    };
  }

  const [requiredSkills, skillResults] = await Promise.all([
    repo.domainRequiredSkills.findByDomainRoleId(user.domain_role_id),
    repo.studentSkillResults.findBySessionId(quizSession.session_id),
  ]);

  if (!requiredSkills.length) {
    const error = new Error("No skills configured for the selected domain");
    error.status = 404;
    throw error;
  }

  const resultBySkillId = new Map(
    skillResults.map((result) => [result.skill_id, result])
  );

  const skills = requiredSkills.map((requiredSkill) => {
    const result = resultBySkillId.get(requiredSkill.skill_id);
    const skillLevel = result ? Number(result.skill_level) : 0;
    const requiredLevel = Number(requiredSkill.required_level);
    const quizPercentage = result ? Number(result.percentage) : 0;
    const levelPercentage = requiredLevel > 0
      ? Math.min(100, (skillLevel / requiredLevel) * 100)
      : 0;

    return {
      skillId: requiredSkill.skill_id,
      skillName: requiredSkill.skill.skill_name,
      requiredLevel,
      skillLevel,
      quizPercentage: Number(quizPercentage.toFixed(2)),
      performancePercentage: Number(levelPercentage.toFixed(2)),
      gapPercentage: Number(Math.max(0, 100 - levelPercentage).toFixed(2)),
    };
  });

  const totalScore = Number(codingSession.total_score || 0);
  const maxScore = Number(codingSession.max_score || 0);
  const codingPercentage = maxScore > 0
    ? (totalScore / maxScore) * 100
    : 0;
  const quizPercentage = skills.length
    ? skills.reduce((sum, skill) => sum + skill.quizPercentage, 0) / skills.length
    : 0;

  return {
    userId,
    domainRole: quizSession.domainRole
      ? {
          id: quizSession.domainRole.domain_role_id,
          name: quizSession.domainRole.domain_name,
        }
      : { id: user.domain_role_id },
    quiz: {
      sessionId: quizSession.session_id,
      percentage: Number(quizPercentage.toFixed(2)),
    },
    codingAssessment: {
      sessionId: codingSession.session_id,
      totalScore,
      maxScore,
      percentage: Number(codingPercentage.toFixed(2)),
      completedAt: codingSession.completed_at,
    },
    skills,
  };
}

async function updateFinalReadiness(
  userId,
  finalQuizScore = null,
  miniProjectScore = null
) {
  const existingReport =
    await repo.gapReports.findByUserId(userId);

  // Initial assessment must already exist.
  // We should not create a standalone readiness report here.
  if (!existingReport) {
    return null;
  }

  let resolvedFinalQuizScore = finalQuizScore;
  let resolvedMiniProjectScore = miniProjectScore;

  /*
   * ------------------------------------------------------------
   * Resolve Final Quiz score if caller did not provide it.
   * ------------------------------------------------------------
   */
  if (resolvedFinalQuizScore == null) {
    const finalSession =
      await repo.quizSessions.findLatestByUserAndAssessmentType(
        userId,
        "FINAL"
      );

    if (finalSession?.status !== "Completed") {
      return null;
    }

    resolvedFinalQuizScore =
      await repo.studentSkillResults.getQuizScoreBySessionId(
        finalSession.session_id
      );
  }

  /*
   * ------------------------------------------------------------
   * Resolve Mini Project score if caller did not provide it.
   * ------------------------------------------------------------
   */
  if (resolvedMiniProjectScore == null) {
    const finalSession =
      await repo.quizSessions.findLatestByUserAndAssessmentType(
        userId,
        "FINAL"
      );

    if (!finalSession?.domain_role_id) {
      return null;
    }

    const currentProject =
      await repo.miniProjects.getCurrentForStudent(
        userId,
        finalSession.domain_role_id
      );

    if (!currentProject?.submissions?.length) {
      return null;
    }

    const completedSubmission =
      currentProject.submissions.find(
        (submission) =>
          submission.analysis?.status === "COMPLETED" &&
          submission.analysis?.readiness_score != null
      );

    if (!completedSubmission) {
      return null;
    }

    resolvedMiniProjectScore =
      Number(
        completedSubmission.analysis.readiness_score
      );
  }

  /*
   * ------------------------------------------------------------
   * Final readiness is valid ONLY when both components exist.
   * ------------------------------------------------------------
   */
  if (
    resolvedFinalQuizScore == null ||
    resolvedMiniProjectScore == null
  ) {
    return null;
  }

  const finalReadiness =
    calculateFinalReadiness(
      resolvedFinalQuizScore,
      resolvedMiniProjectScore
    );

  const effectiveReadiness =
    calculateEffectiveReadiness(
      existingReport.initial_readiness_score,
      finalReadiness
    );

  return repo.gapReports.upsert(userId, {
    readiness_score: effectiveReadiness,

    initial_readiness_score:
      existingReport.initial_readiness_score,

    final_readiness_score:
      finalReadiness,

    missing_skills:
      existingReport.missing_skills,

    recommendations:
      existingReport.recommendations,
  });
}

module.exports = {
  generateGapReport,
  computeSkillGap,
  getSkillGapAnalysis,
  updateFinalReadiness,
};