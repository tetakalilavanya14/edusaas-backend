const repo = require("../data");
const { assessments } = require("../data/prismaRepo");
const adaptiveQuizService = require("./adaptiveQuizService");
const skillGapService = require("./skillGapService");

const INITIAL_ASSESSMENT_DURATION_MINUTES = Number(process.env.INITIAL_ASSESSMENT_DURATION_MINUTES || 30)
const INITIAL_ASSESSMENT_DURATION_MS = INITIAL_ASSESSMENT_DURATION_MINUTES * 60 * 1000;

const FINAL_ASSESSMENT_DURATION_MINUTES = Number(process.env.FINAL_ASSESSMENT_DURATION_MINUTES || 30)
const FINAL_ASSESSMENT_DURATION_MS = FINAL_ASSESSMENT_DURATION_MINUTES * 60 * 1000

const codingAssessmentService = require("./codingAssessmentService");


if (
  !Number.isFinite(INITIAL_ASSESSMENT_DURATION_MINUTES) ||
  INITIAL_ASSESSMENT_DURATION_MINUTES <= 0
) {
  throw new Error(
    "INITIAL_ASSESSMENT_DURATION_MINUTES must be a positive number."
  );
}

// Strip the answer key before anything goes back to the client.
function toClientQuestion(question) {
  if (!question) return null;
  const { correct_option, ...rest } = question;
  return rest;
}

// Start the initial adaptive assessment
async function startInitialAssessment(userId) {
  const user = await repo.users.findById(userId);

   let approvedInitialRestart = false;
   let approvedCodingRestart = false;

  if (!user) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }

  /*
   * ============================================================
   * FIND EXISTING ASSESSMENT
   * ============================================================
   */
  let existingSession = await repo.quizSessions.findLatestByUserAndAssessmentType(userId, "INITIAL");

  // ------------------------------------------------------------
  // INITIAL QUIZ IS COMPLETED -> CHECK CODING PHASE
  // ------------------------------------------------------------
  if (existingSession?.status === "Completed") {
    const codingSession =
      await repo.codingSessions.findBySessionAndUser(
        existingSession.session_id,
        userId
      );

    // Coding already exists and is either active or paused.
    if (
      codingSession &&
      (codingSession.status === "In Progress" ||
        codingSession.status === "Paused")
    ) {
      return {
  resumed: true,
  phase: "coding",
  session_id: existingSession.session_id,

  coding_assessment: {
    question_count: codingAssessmentService.CODING_QUESTION_COUNT,
    format: "Practical Coding",
  },

  coding_session: {
    status: codingSession.status,
    remaining_seconds: Number(
      codingSession.remaining_seconds || 0
    ),
  },
};
    }

 // ------------------------------------------------------------
// CODING ASSESSMENT WAS TERMINATED
// ------------------------------------------------------------
// The old quiz + coding session must remain as history.
// Student can restart only after Admin approves the report.
if (
  codingSession &&
  codingSession.status === "Terminated"
) {
  const report =
    await repo.assessmentReports.findByStudentAndSession(
      userId,
      existingSession.session_id,
      "INITIAL_CODING"
    );

  if (!report || report.status !== "Approved") {
    const error = new Error(
      report
        ? `This coding assessment cannot be restarted until your report is approved. Current status: ${report.status}.`
        : "This coding assessment has been terminated. Please report the issue to Admin before restarting."
    );

    error.status = 409;
    error.code = "ASSESSMENT_TERMINATED";

    throw error;
  }

  /*
   * Admin approved the termination report.
   *
   * Do NOT modify the old Initial Quiz session.
   * Do NOT modify the old Terminated Coding session.
   *
   * The old session remains as audit/history.
   *
   * Continue to the normal CREATE NEW ASSESSMENT flow below.
   */
}
     // ------------------------------------------------------------
    // CODING ASSESSMENT WAS TERMINATED
    // ------------------------------------------------------------
    // The old quiz + coding session must remain as history.
    // Student can restart only after Admin approves the report.
    if (
      codingSession &&
      codingSession.status === "Terminated"
    ) {
      const report =
        await repo.assessmentReports.findByStudentAndSession(
          userId,
          existingSession.session_id,
          "INITIAL_CODING"
        );

      if (!report || report.status !== "Approved") {
        const error = new Error(
          report
            ? `This coding assessment cannot be restarted until your report is approved. Current status: ${report.status}.`
            : "This coding assessment has been terminated. Please report the issue to Admin before restarting."
        );

        error.status = 409;
        error.code = "ASSESSMENT_TERMINATED";

        throw error;
      }

      /*
       * Admin approved the termination report.
       *
       * Do NOT modify the old Initial Quiz session.
       * Do NOT modify the old Terminated Coding session.
       *
       * Keep the old session as audit/history.
       *
       * Continue into the normal CREATE NEW ASSESSMENT flow.
       */
      approvedCodingRestart = true;
      existingSession = null;
    }

    // Only continue with the old coding session if it still exists.
    if (existingSession) {
      // Coding is already terminal.
      if (
        codingSession &&
        (codingSession.status === "Completed" ||
          codingSession.status === "Timed Out")
      ) {
        return {
          resumed: true,
          phase: "completed",
          session_id: existingSession.session_id,
        };
      }

      // Initial quiz is complete but coding has never been started.
      // Tell frontend to enter coding.
      return {
        resumed: false,
        phase: "coding",
        session_id: existingSession.session_id,

        coding_assessment: {
          question_count: codingAssessmentService.CODING_QUESTION_COUNT,
          format: "Practical Coding",
        },
      };
    }
  }

  // Prevent starting a brand-new assessment after full completion
  const profile = await repo.profiles.findByUserId(userId);

if (
  profile?.initial_assessment_completed === true &&
  !approvedInitialRestart &&
  !approvedCodingRestart
) {
  const error = new Error("Initial assessment already completed");
  error.status = 409;
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

  const requiredSkills =
    (
      await repo.domainRequiredSkills.findByDomainRoleId(
        user.domain_role_id
      )) || [];

  if (!requiredSkills.length) {
    const error = new Error(
      "No skills configured for the selected domain"
    );
    error.status = 404;
    throw error;
  }

  const totalQuestions = requiredSkills.length * 10;


  // Terminal state - do not create new session
  if (existingSession) {
    if (existingSession.status === "Completed") {
      const error = new Error(
        "This assessment has already been completed."
      );

      error.status = 409;
      error.code = "ASSESSMENT_ALREADY_COMPLETED";

      throw error;
    }

   if (existingSession.status === "Terminated") {
  const report =
    await repo.assessmentReports.findByStudentAndSession(
      userId,
      existingSession.session_id,
      "INITIAL_QUIZ"
    );

  if (!report || report.status !== "Approved") {
    const error = new Error(
      report
        ? `This assessment cannot be restarted until your report is approved. Current status: ${report.status}.`
        : "This assessment has been terminated. Please report the issue to Admin before restarting."
    );

    error.status = 409;
    error.code = "ASSESSMENT_TERMINATED";

    throw error;
  }

  // Admin approved the Initial Quiz termination report.
  // Keep the old terminated session as history.
  // Continue into the normal new-assessment creation flow.
  approvedInitialRestart = true;
  existingSession = null;
}

   if (existingSession && existingSession.status === "Timed Out") {
      const error = new Error(
        "This assessment has already expired."
      );

      error.status = 409;
      error.code = "ASSESSMENT_TIME_EXPIRED";

      throw error;
    }
  }

  /*
   * ============================================================
   * RESUME EXISTING ASSESSMENT (READ-ONLY W.R.T. THE TIMER)
   * ============================================================
   *
   * IMPORTANT — this function is called every time the page loads
   * (InitialAssessment.js calls it on mount, before the student has
   * clicked "Resume"/"Start", before the camera permission prompt,
   * before proctoring has connected). It must NEVER start or restart
   * the countdown itself, or the student loses real exam time just
   * sitting on the "Resume Assessment" screen or waiting on a camera
   * permission dialog.
   *
   * Flipping a "Paused" session back to "In Progress" (i.e. actually
   * starting the deadline) only happens in activateInitialAssessment(),
   * which the frontend calls at the exact moment the student clicks
   * the Resume/Start button.
   */
  if (existingSession) {
    const now = new Date();

    /*
     * ----------------------------------------------------------
     * CASE 1: PAUSED SESSION
     * ----------------------------------------------------------
     *
     * remaining_seconds is the authoritative remaining time, and it
     * is left completely untouched here. We only check whether it
     * had already hit zero at the moment it was paused (edge case),
     * we do NOT create a new deadline yet.
     */
    if (existingSession.status === "Paused") {
      const remainingSeconds =
        Number(existingSession.remaining_seconds);

      if (
        !Number.isInteger(remainingSeconds) ||
        remainingSeconds <= 0
      ) {
        await repo.quizSessions.update(
          existingSession.session_id,
          {
            status: "Timed Out",
            end_time: now,
            remaining_seconds: 0,
          }
        );

        const error = new Error(
          "The assessment time has expired."
        );

        error.status = 409;
        error.code = "ASSESSMENT_TIME_EXPIRED";

        throw error;
      }

      existingSession.remaining_seconds = remainingSeconds;
    }

    /*
     * ----------------------------------------------------------
     * CASE 2: ALREADY IN PROGRESS
     * ----------------------------------------------------------
     *
     * Do NOT reset the timer.
     *
     * The existing deadline remains authoritative. This is a
     * genuinely live session (e.g. the student refreshed the page
     * mid-exam) — the clock correctly keeps counting down.
     */
    let liveRemainingSeconds = null;

    if (existingSession.status === "In Progress") {
      if (!existingSession.deadline_at) {
        const error = new Error(
          "Assessment timer information is missing."
        );

        error.status = 500;
        throw error;
      }

      const deadlineTime =
        new Date(existingSession.deadline_at).getTime();

      liveRemainingSeconds = Math.max(
        0,
        Math.floor(
          (deadlineTime - now.getTime()) / 1000
        )
      );

      /*
       * Server-side timeout check.
       */
      if (liveRemainingSeconds <= 0) {
        await repo.quizSessions.update(
          existingSession.session_id,
          {
            status: "Timed Out",
            end_time: now,
            remaining_seconds: 0,
          }
        );

        const error = new Error(
          "The assessment time has expired."
        );

        error.status = 409;
        error.code = "ASSESSMENT_TIME_EXPIRED";

        throw error;
      }
    }

        /*
     * ----------------------------------------------------------
     * CURRENT QUESTION MUST EXIST
     * ----------------------------------------------------------
     */

    /*
     * ----------------------------------------------------------
     * RECOVER MISSING CURRENT QUESTION
     * ----------------------------------------------------------
     *
     * A paused session can occasionally exist without a
     * current_question_id if assessment initialization was
     * interrupted after the session was created.
     *
     * Recover only when no question has been answered yet.
     */

    if (
      !existingSession.current_question_id &&
      existingSession.status === "Paused" &&
      Number(existingSession.questions_answered || 0) === 0
    ) {
      console.log(
        "Recovering assessment session:",
        existingSession.session_id
      );

      const recoverySkill =
        requiredSkills.find(
          (rs) =>
            rs.skill_id === existingSession.current_skill_id
        ) || requiredSkills[0];

      if (!recoverySkill) {
        const error = new Error(
          "Unable to recover assessment because no skill is available."
        );

        error.status = 500;
        throw error;
      }

      /*
       * Get questions for the current skill.
       */
      const recoveryQuestions =
        await repo.questions.findBySkill(
          recoverySkill.skill_id
        );

      if (!recoveryQuestions?.length) {
        const error = new Error(
          "No questions are available for the current assessment skill."
        );

        error.status = 404;
        throw error;
      }

      /*
       * Recreate the missing adaptive quiz state.
       */
      const recoveryStateResponse =
        await flaskService.createQuizState({
          session_id:
            existingSession.session_id,

          skill: {
            skill_id:
              recoverySkill.skill_id,

            skill_name:
              recoverySkill.skill.skill_name,
          },
        });

      const recoveryState =
        recoveryStateResponse.state;

      /*
       * Persist the recovered quiz state.
       */
      await repo.quizStates.create({
        session_id:
          existingSession.session_id,

        skill_id:
          recoverySkill.skill_id,

        current_difficulty:
          recoveryState.current_difficulty,

        correct_streak:
          recoveryState.correct_streak,

        wrong_streak:
          recoveryState.wrong_streak,

        questions_answered:
          recoveryState.questions_answered,

        obtained_score:
          recoveryState.obtained_score,

        maximum_score:
          recoveryState.maximum_score,

        state:
          recoveryState,
      });

      /*
       * Ask the adaptive engine for the first question.
       */
      const recoveryQuestionResponse =
        await flaskService.getNextQuestion({
          state: recoveryState,
          questions: recoveryQuestions,
        });

      if (!recoveryQuestionResponse?.question) {
        const error = new Error(
          "No question is available for the current assessment skill."
        );

        error.status = 500;
        throw error;
      }

      /*
       * Save the recovered current question.
       */
      await repo.quizSessions.update(
        existingSession.session_id,
        {
          current_skill_id:
            recoverySkill.skill_id,

          current_question_id:
            recoveryQuestionResponse.question.question_id,
        }
      );

      /*
       * Keep the in-memory session consistent for the
       * remainder of this resume request.
       */
      existingSession.current_skill_id =
        recoverySkill.skill_id;

      existingSession.current_question_id =
        recoveryQuestionResponse.question.question_id;
    }

    let currentQuestion = null;

    if (existingSession.current_question_id) {
      currentQuestion = await repo.questions.findById(
        existingSession.current_question_id
      );
    }

    if (!currentQuestion) {
      const existingState = await repo.quizStates.findById(
        existingSession.session_id,
        existingSession.current_skill_id
      );

      if (!existingState || !existingState.state) {
        const error = new Error(
          "Assessment cannot be resumed because its current quiz state is missing."
        );

        error.status = 500;
        throw error;
      }

      const questions = await repo.questions.findBySkill(
        existingSession.current_skill_id,
        "INITIAL"
      );

      const questionResponse = await adaptiveQuizService.getNextQuestion({
        state: existingState.state,
        questions,
      });

      if (!questionResponse?.question) {
        const error = new Error(
          "Unable to recover the current assessment question."
        );

        error.status = 500;
        throw error;
      }

      currentQuestion = questionResponse.question;

      await repo.quizSessions.update(
        existingSession.session_id,
        {
          current_question_id: currentQuestion.question_id,
        }
      );
    }
    /*
     * ----------------------------------------------------------
     * CURRENT REMAINING TIME (DISPLAY ONLY — NOT PERSISTED)
     * ----------------------------------------------------------
     *
     * Paused  -> use the stored remaining_seconds as-is.
     * In Progress -> use the live countdown computed above.
     */
    const remainingSeconds =
      existingSession.status === "Paused"
        ? Number(existingSession.remaining_seconds)
        : liveRemainingSeconds;

    /*
     * ----------------------------------------------------------
     * BUILD ASSESSMENT PROGRESS
     * ----------------------------------------------------------
     */
    const completedResults =
      await repo.studentSkillResults.findBySessionId(
        existingSession.session_id
      );

    const completedSkillIds = new Set(
      completedResults.map((r) => r.skill_id)
    );

    const currentSkill =
      requiredSkills.find(
        (rs) =>
          rs.skill_id ===
          existingSession.current_skill_id
      ) || requiredSkills[0];

    const currentSkillIndex = Math.max(
      0,
      requiredSkills.findIndex(
        (rs) =>
          rs.skill_id ===
          existingSession.current_skill_id
      )
    );

    const questionsAnswered =
      existingSession.questions_answered || 0;

    const assessmentMeta = {
      total_skills: requiredSkills.length,

      questions_per_skill: 10,

      total_questions: totalQuestions,

      current_skill_index: currentSkillIndex,

      overall_question:
        questionsAnswered + 1,

      remaining_questions:
        Math.max(
          0,
          totalQuestions - questionsAnswered
        ),

      skills: requiredSkills.map(
        (item, index) => ({
          skill_id: item.skill_id,

          skill_name:
            item.skill.skill_name,

          index,

          status:
            completedSkillIds.has(item.skill_id)
              ? "completed"
              : item.skill_id ===
                existingSession.current_skill_id
                ? "current"
                : "upcoming",
        })
      ),
    };

    /*
     * ----------------------------------------------------------
     * RETURN RESUMED ASSESSMENT
     * ----------------------------------------------------------
     */
    return {
      resumed: true,

      session_id:
        existingSession.session_id,

      timer: {
        duration_seconds:
          INITIAL_ASSESSMENT_DURATION_MINUTES * 60,

        deadline_at:
          existingSession.deadline_at,

        remaining_seconds:
          remainingSeconds,
      },

      domain: {
        domain_role_id:
          user.domain_role_id,

        domain_name:
          user.domain_role,
      },

      assessment: assessmentMeta,

      skill: {
        skill_id:
          currentSkill.skill_id,

        skill_name:
          currentSkill.skill.skill_name,
      },

      question:
        toClientQuestion(currentQuestion),
    };
  }

  /*
   * ============================================================
   * CREATE NEW ASSESSMENT
   * ============================================================
   */

  const firstSkill = requiredSkills[0];

  const questions = await repo.questions.findBySkill(
    firstSkill.skill_id,
    "INITIAL"
  );

  if (!questions.length) {
    const error = new Error(
      "No questions available for the first skill."
    );

    error.status = 404;
    throw error;
  }

  const startTime = new Date();

  const durationSeconds =
    INITIAL_ASSESSMENT_DURATION_MINUTES * 60;

  /*
   * ----------------------------------------------------------
   * CREATE SESSION — STARTS "Paused", NOT "In Progress"
   * ----------------------------------------------------------
   *
   * The clock does not start here. This call happens on page load,
   * before the student has granted camera permission or clicked
   * "Start Assessment". We create the session and the first question
   * up front (that work is independent of the timer), but leave the
   * deadline unset. activateInitialAssessment() sets the real
   * deadline the moment the student actually clicks Start — see the
   * note above CASE 1 for why.
   */
  const quizSession =
    await repo.quizSessions.create({
      user_id: userId,

      domain_role_id:
        user.domain_role_id,

      assessment_type: "INITIAL",

      start_time: startTime,

      deadline_at: null,

      remaining_seconds:
        durationSeconds,

      paused_at: startTime,

      status: "Paused",

      total_questions:
        totalQuestions,

      questions_answered: 0,

      current_skill_id:
        firstSkill.skill_id,

      current_question_id: null,
    });

  /*
   * ----------------------------------------------------------
   * CREATE FLASK ADAPTIVE STATE
   * ----------------------------------------------------------
   */




  const stateResponse =
    await adaptiveQuizService.createQuizState({
      session_id:
        quizSession.session_id,

      skill: {
        skill_id:
          firstSkill.skill_id,

        skill_name:
          firstSkill.skill.skill_name,
      },
      assessment_type: "INITIAL",
    });


  const state =
    stateResponse.state;

  /*
   * ----------------------------------------------------------
   * SAVE QUIZ STATE
   * ----------------------------------------------------------
   */
  await repo.quizStates.create({
    session_id:
      quizSession.session_id,

    skill_id:
      firstSkill.skill_id,

    current_difficulty:
      state.current_difficulty,

    correct_streak:
      state.correct_streak,

    wrong_streak:
      state.wrong_streak,

    questions_answered:
      state.questions_answered,

    obtained_score:
      state.obtained_score,

    maximum_score:
      state.maximum_score,

    state,
  });

  /*
   * ----------------------------------------------------------
   * GET FIRST ADAPTIVE QUESTION
   * ----------------------------------------------------------
   */

  const questionResponse =
    await adaptiveQuizService.getNextQuestion({
      state,

      questions,
    });

  if (!questionResponse.question) {
    const error = new Error(
      "No question available for this skill."
    );

    error.status = 404;
    throw error;
  }



  // --------------------------------------------------
  // Response
  // --------------------------------------------------



  const firstQuestion = questionResponse.question;
  const actualQuestionId = firstQuestion?.question_id || firstQuestion?.id;

  if (!actualQuestionId) {
    throw new Error("AI service returned a question without a valid ID (question_id or id missing).");
  }

  /*
   * ----------------------------------------------------------
   * IMPORTANT:
   *
   * Save the exact question being displayed.
   *
   * This is what allows us to resume on the
   * exact same question.
   * ----------------------------------------------------------
   */
  await repo.quizSessions.update(
    quizSession.session_id,
    {
      current_question_id: actualQuestionId,
    }
  );

  /*
   * ----------------------------------------------------------
   * ASSESSMENT META
   * ----------------------------------------------------------
   */
  const assessmentMeta = {
    total_skills:
      requiredSkills.length,

    questions_per_skill: 10,

    total_questions:
      totalQuestions,

    current_skill_index: 0,

    overall_question: 1,

    remaining_questions:
      totalQuestions - 1,

    skills:
      requiredSkills.map(
        (item, index) => ({
          skill_id:
            item.skill_id,

          skill_name:
            item.skill.skill_name,

          index,

          status:
            index === 0
              ? "current"
              : "upcoming",
        })
      ),
  };

  /*
   * ----------------------------------------------------------
   * RETURN NEW ASSESSMENT
   * ----------------------------------------------------------
   */
  return {
    resumed: false,

    session_id:
      quizSession.session_id,

    timer: {
      duration_seconds:
        durationSeconds,

      deadline_at: null,

      remaining_seconds:
        durationSeconds,
    },

    domain: {
      domain_role_id:
        user.domain_role_id,

      domain_name:
        user.domain_role,
    },

    assessment:
      assessmentMeta,

    skill: {
      skill_id:
        firstSkill.skill_id,

      skill_name:
        firstSkill.skill.skill_name,
    },

    question:
      toClientQuestion(firstQuestion),
  };
}

// Start the final adaptive assessment
async function startFinalAssessment(userId) {
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

  const requiredSkills =
    (
      await repo.domainRequiredSkills.findByDomainRoleId(
        user.domain_role_id
      )
    ) || [];

  if (!requiredSkills.length) {
    const error = new Error(
      "No skills configured for the selected domain"
    );
    error.status = 404;
    throw error;
  }

  const totalQuestions = requiredSkills.length * 10;

  /*
   * ============================================================
   * FIND EXISTING FINAL ASSESSMENT
   * ============================================================
   */
 let existingSession =
  await repo.quizSessions.findLatestByUserAndAssessmentType(
    userId,
    "FINAL"
  );
  /*
   * ============================================================
   * RESUME EXISTING FINAL ASSESSMENT
   * ============================================================
   */
  if (existingSession) {
    const now = new Date();

    if (existingSession.status === "Terminated") {
  const report =
    await repo.assessmentReports.findByStudentAndSession(
      userId,
      existingSession.session_id,
      "FINAL_QUIZ"
    );

  // Student cannot restart until Admin approves
  if (!report || report.status !== "Approved") {
    const error = new Error(
      report
        ? `This assessment cannot be restarted until your report is approved. Current status: ${report.status}.`
        : "This assessment has been terminated. Please report the issue to Admin before restarting."
    );

    error.status = 409;
    error.code = "ASSESSMENT_TERMINATED";

    throw error;
  }

  /*
   * Admin approved the report.
   *
   * Keep the old Terminated session as history.
   * Setting this to null makes the function continue
   * into the existing CREATE NEW FINAL ASSESSMENT flow.
   */
  existingSession = null;
}

    /*
     * ----------------------------------------------------------
     * PAUSED SESSION
     * ----------------------------------------------------------
     */
    if (existingSession.status === "Paused") {
      const remainingSeconds =
        Number(existingSession.remaining_seconds);

      if (
        !Number.isInteger(remainingSeconds) ||
        remainingSeconds <= 0
      ) {
        await repo.quizSessions.update(
          existingSession.session_id,
          {
            status: "Timed Out",
            end_time: now,
            remaining_seconds: 0,
          }
        );

        const error = new Error(
          "The assessment time has expired."
        );

        error.status = 409;
        error.code = "ASSESSMENT_TIME_EXPIRED";

        throw error;
      }

      existingSession.remaining_seconds =
        remainingSeconds;
    }

    /*
     * ----------------------------------------------------------
     * IN-PROGRESS SESSION
     * ----------------------------------------------------------
     */
    let liveRemainingSeconds = null;

    if (existingSession.status === "In Progress") {
      if (!existingSession.deadline_at) {
        const error = new Error(
          "Assessment timer information is missing."
        );

        error.status = 500;
        throw error;
      }

      const deadlineTime =
        new Date(
          existingSession.deadline_at
        ).getTime();

      liveRemainingSeconds = Math.max(
        0,
        Math.floor(
          (deadlineTime - now.getTime()) / 1000
        )
      );

      if (liveRemainingSeconds <= 0) {
        await repo.quizSessions.update(
          existingSession.session_id,
          {
            status: "Timed Out",
            end_time: now,
            remaining_seconds: 0,
          }
        );

        const error = new Error(
          "The assessment time has expired."
        );

        error.status = 409;
        error.code = "ASSESSMENT_TIME_EXPIRED";

        throw error;
      }
    }

    /*
     * ----------------------------------------------------------
     * RECOVER CURRENT QUESTION
     * ----------------------------------------------------------
     */
    let currentQuestion = null;

    if (existingSession.current_question_id) {
      currentQuestion =
        await repo.questions.findById(
          existingSession.current_question_id
        );
    }

    if (!currentQuestion) {
      const existingState =
        await repo.quizStates.findById(
          existingSession.session_id,
          existingSession.current_skill_id
        );

      if (
        !existingState ||
        !existingState.state
      ) {
        const error = new Error(
          "Assessment cannot be resumed because its current quiz state is missing."
        );

        error.status = 500;
        throw error;
      }

      /*
       * IMPORTANT:
       * Final assessment only receives FINAL questions.
       */
      const questions =
        await repo.questions.findBySkill(
          existingSession.current_skill_id,
          "FINAL"
        );

      const questionResponse =
        await adaptiveQuizService.getNextQuestion({
          state: existingState.state,
          questions,
        });

      if (!questionResponse?.question) {
        const error = new Error(
          "Unable to recover the current assessment question."
        );

        error.status = 500;
        throw error;
      }

      currentQuestion =
        questionResponse.question;

      await repo.quizSessions.update(
        existingSession.session_id,
        {
          current_question_id:
            currentQuestion.question_id,
        }
      );
    }

    const remainingSeconds =
      existingSession.status === "Paused"
        ? Number(existingSession.remaining_seconds)
        : liveRemainingSeconds;

    /*
     * ----------------------------------------------------------
     * BUILD FINAL ASSESSMENT PROGRESS
     * ----------------------------------------------------------
     */
    const completedResults =
      await repo.studentSkillResults.findBySessionId(
        existingSession.session_id
      );

    const completedSkillIds =
      new Set(
        completedResults.map(
          (r) => r.skill_id
        )
      );

    const currentSkill =
      requiredSkills.find(
        (rs) =>
          rs.skill_id ===
          existingSession.current_skill_id
      ) || requiredSkills[0];

    const currentSkillIndex =
      Math.max(
        0,
        requiredSkills.findIndex(
          (rs) =>
            rs.skill_id ===
            existingSession.current_skill_id
        )
      );

    const questionsAnswered =
      existingSession.questions_answered || 0;

    const assessmentMeta = {
      total_skills:
        requiredSkills.length,

      questions_per_skill: 10,

      total_questions:
        totalQuestions,

      current_skill_index:
        currentSkillIndex,

      overall_question:
        questionsAnswered + 1,

      remaining_questions:
        Math.max(
          0,
          totalQuestions -
          questionsAnswered
        ),

      skills:
        requiredSkills.map(
          (item, index) => ({
            skill_id:
              item.skill_id,

            skill_name:
              item.skill.skill_name,

            index,

            status:
              completedSkillIds.has(
                item.skill_id
              )
                ? "completed"
                : item.skill_id ===
                  existingSession.current_skill_id
                  ? "current"
                  : "upcoming",
          })
        ),
    };

    return {
      resumed: true,

      session_id:
        existingSession.session_id,

      timer: {
        duration_seconds:
          FINAL_ASSESSMENT_DURATION_MINUTES *
          60,

        deadline_at:
          existingSession.deadline_at,

        remaining_seconds:
          remainingSeconds,
      },

      domain: {
        domain_role_id:
          user.domain_role_id,

        domain_name:
          user.domain_role,
      },

      assessment:
        assessmentMeta,

      skill: {
        skill_id:
          currentSkill.skill_id,

        skill_name:
          currentSkill.skill.skill_name,
      },

      question:
        toClientQuestion(
          currentQuestion
        ),
    };
  }

  /*
   * ============================================================
   * CREATE NEW FINAL ASSESSMENT
   * ============================================================
   */

  const firstSkill =
    requiredSkills[0];

  /*
   * FINAL QUESTION BANK ONLY
   */
  const questions =
    await repo.questions.findBySkill(
      firstSkill.skill_id,
      "FINAL"
    );

  if (!questions.length) {
    const error = new Error(
      "No final questions available for the first skill."
    );

    error.status = 404;
    throw error;
  }

  const startTime = new Date();

  const durationSeconds =
    FINAL_ASSESSMENT_DURATION_MINUTES *
    60;

  /*
   * ----------------------------------------------------------
   * CREATE FINAL SESSION
   * ----------------------------------------------------------
   */
  const quizSession =
    await repo.quizSessions.create({
      user_id: userId,

      domain_role_id:
        user.domain_role_id,

      assessment_type:
        "FINAL",

      start_time:
        startTime,

      deadline_at:
        null,

      remaining_seconds:
        durationSeconds,

      paused_at:
        startTime,

      status:
        "Paused",

      total_questions:
        totalQuestions,

      questions_answered:
        0,

      current_skill_id:
        firstSkill.skill_id,

      current_question_id:
        null,
    });

  /*
   * ----------------------------------------------------------
   * CREATE ADAPTIVE STATE
   * ----------------------------------------------------------
   */
  const stateResponse =
    await adaptiveQuizService.createQuizState({
      session_id:
        quizSession.session_id,

      skill: {
        skill_id:
          firstSkill.skill_id,

        skill_name:
          firstSkill.skill.skill_name,
      },
    });

  /*
   * IMPORTANT:
   *
   * Python currently starts every quiz at difficulty 1.
   *
   * Final Quiz starts at Medium = difficulty 2.
   *
   * We therefore override the returned state in Node
   * instead of changing the Python create-state API.
   */
  const state = {
    ...stateResponse.state,
    current_difficulty: 2,
  };

  /*
   * ----------------------------------------------------------
   * SAVE FINAL QUIZ STATE
   * ----------------------------------------------------------
   */
  await repo.quizStates.create({
    session_id:
      quizSession.session_id,

    skill_id:
      firstSkill.skill_id,

    current_difficulty:
      state.current_difficulty,

    correct_streak:
      state.correct_streak,

    wrong_streak:
      state.wrong_streak,

    questions_answered:
      state.questions_answered,

    obtained_score:
      state.obtained_score,

    maximum_score:
      state.maximum_score,

    state,
  });

  /*
   * ----------------------------------------------------------
   * GET FIRST FINAL ADAPTIVE QUESTION
   * ----------------------------------------------------------
   */
  const questionResponse =
    await adaptiveQuizService.getNextQuestion({
      state,
      questions,
    });

  if (!questionResponse?.question) {
    const error = new Error(
      "No final question available for this skill."
    );

    error.status = 404;
    throw error;
  }

  const firstQuestion =
    questionResponse.question;

  /*
   * Save exact question for resume.
   */
  await repo.quizSessions.update(
    quizSession.session_id,
    {
      current_question_id:
        firstQuestion.question_id,
    }
  );

  const assessmentMeta = {
    total_skills:
      requiredSkills.length,

    questions_per_skill: 10,

    total_questions:
      totalQuestions,

    current_skill_index: 0,

    overall_question: 1,

    remaining_questions:
      totalQuestions - 1,

    skills:
      requiredSkills.map(
        (item, index) => ({
          skill_id:
            item.skill_id,

          skill_name:
            item.skill.skill_name,

          index,

          status:
            index === 0
              ? "current"
              : "upcoming",
        })
      ),
  };

  return {
    resumed: false,

    session_id:
      quizSession.session_id,

    timer: {
      duration_seconds:
        durationSeconds,

      deadline_at:
        null,

      remaining_seconds:
        durationSeconds,
    },

    domain: {
      domain_role_id:
        user.domain_role_id,

      domain_name:
        user.domain_role,
    },

    assessment:
      assessmentMeta,

    skill: {
      skill_id:
        firstSkill.skill_id,

      skill_name:
        firstSkill.skill.skill_name,
    },

    question:
      toClientQuestion(
        firstQuestion
      ),
  };
}

/*
 * ============================================================
 * ACTIVATE (START/RESUME) THE ASSESSMENT TIMER
 * ============================================================
 *
 * This is the ONLY place the countdown deadline is ever set. The
 * frontend calls this at the exact moment the student clicks the
 * "Start/Resume Assessment" button — after that, it immediately
 * connects proctoring, which itself requires status "In Progress"
 * (see proctoringGateway.js), so this must run before that call.
 *
 * Idempotent: calling it again while already "In Progress" just
 * returns the live remaining time without resetting the deadline
 * (no free extra time from double-clicks or reconnects).
 */
async function activateInitialAssessment(userId, sessionId) {
  const quizSession =
    await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error("Quiz session not found");
    error.status = 404;
    throw error;
  }

  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );
    error.status = 403;
    throw error;
  }

  if (quizSession.status === "Completed") {
    const error = new Error(
      "This assessment has already been completed."
    );
    error.status = 409;
    throw error;
  }

  if (quizSession.status === "Terminated") {
    const error = new Error(
      "This assessment has been terminated and cannot be restarted."
    );
    error.status = 409;
    throw error;
  }

  if (quizSession.status === "Timed Out") {
    const error = new Error(
      "This assessment has already expired."
    );
    error.status = 409;
    error.code = "ASSESSMENT_TIME_EXPIRED";
    throw error;
  }

  const now = new Date();

  // Already ticking (e.g. a reconnect/double-click) — don't touch
  // the deadline, just the live remaining time.
  if (quizSession.status === "In Progress") {
    if (!quizSession.deadline_at) {
      const error = new Error(
        "Assessment timer information is missing."
      );
      error.status = 500;
      throw error;
    }

    const remainingSeconds = Math.max(
      0,
      Math.floor(
        (new Date(quizSession.deadline_at).getTime() - now.getTime()) / 1000
      )
    );

    if (remainingSeconds <= 0) {
      await repo.quizSessions.update(sessionId, {
        status: "Timed Out",
        end_time: now,
        remaining_seconds: 0,
      });

      const error = new Error("The assessment time has expired.");
      error.status = 409;
      error.code = "ASSESSMENT_TIME_EXPIRED";
      throw error;
    }

    return {
      activated: true,
      session_id: sessionId,
      remaining_seconds: remainingSeconds,
      deadline_at: quizSession.deadline_at,
    };
  }

  if (quizSession.status !== "Paused") {
    const error = new Error(
      "This assessment cannot be started in its current state."
    );
    error.status = 409;
    throw error;
  }

  const remainingSeconds = Number(quizSession.remaining_seconds);

  if (!Number.isInteger(remainingSeconds) || remainingSeconds <= 0) {
    await repo.quizSessions.update(sessionId, {
      status: "Timed Out",
      end_time: now,
      remaining_seconds: 0,
    });

    const error = new Error("The assessment time has expired.");
    error.status = 409;
    error.code = "ASSESSMENT_TIME_EXPIRED";
    throw error;
  }

  const activeSession =
    await repo.quizSessions.findActiveByUser(userId);

  if (
    activeSession &&
    activeSession.session_id !== sessionId
  ) {
    const error = new Error(
      `Another assessment is already in progress (session ${activeSession.session_id}).`
    );
    error.status = 409;
    error.code = "ANOTHER_ASSESSMENT_IN_PROGRESS";
    throw error;
  }

  // This is the moment the exam clock actually starts.
  const newDeadline = new Date(now.getTime() + remainingSeconds * 1000);

  await repo.quizSessions.update(sessionId, {
    status: "In Progress",
    deadline_at: newDeadline,
    paused_at: null,
  });

  return {
    activated: true,
    session_id: sessionId,
    remaining_seconds: remainingSeconds,
    deadline_at: newDeadline,
  };
}

// Activate Final Assessment
async function activateFinalAssessment(userId, sessionId) {
  const quizSession =
    await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error("Quiz session not found");
    error.status = 404;
    throw error;
  }

  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );
    error.status = 403;
    throw error;
  }

  // ------------------------------------------------------------
  // Final Assessment validation
  // ------------------------------------------------------------
  if (quizSession.assessment_type !== "FINAL") {
    const error = new Error(
      "This session does not belong to the Final Assessment."
    );
    error.status = 409;
    error.code = "INVALID_ASSESSMENT_TYPE";
    throw error;
  }

  if (quizSession.status === "Completed") {
    const error = new Error(
      "This assessment has already been completed."
    );
    error.status = 409;
    throw error;
  }

  if (quizSession.status === "Terminated") {
    const error = new Error(
      "This assessment has been terminated and cannot be restarted."
    );
    error.status = 409;
    throw error;
  }

  if (quizSession.status === "Timed Out") {
    const error = new Error(
      "This assessment has already expired."
    );
    error.status = 409;
    error.code = "ASSESSMENT_TIME_EXPIRED";
    throw error;
  }

  const now = new Date();

  // ------------------------------------------------------------
  // Already active — do not reset the deadline
  // ------------------------------------------------------------
  if (quizSession.status === "In Progress") {
    if (!quizSession.deadline_at) {
      const error = new Error(
        "Assessment timer information is missing."
      );
      error.status = 500;
      throw error;
    }

    const remainingSeconds = Math.max(
      0,
      Math.floor(
        (
          new Date(
            quizSession.deadline_at
          ).getTime() -
          now.getTime()
        ) / 1000
      )
    );

    if (remainingSeconds <= 0) {
      await repo.quizSessions.update(sessionId, {
        status: "Timed Out",
        end_time: now,
        remaining_seconds: 0,
      });

      const error = new Error(
        "The assessment time has expired."
      );

      error.status = 409;
      error.code = "ASSESSMENT_TIME_EXPIRED";

      throw error;
    }

    return {
      activated: true,
      session_id: sessionId,
      remaining_seconds: remainingSeconds,
      deadline_at: quizSession.deadline_at,
    };
  }

  // ------------------------------------------------------------
  // Only Paused sessions can be activated
  // ------------------------------------------------------------
  if (quizSession.status !== "Paused") {
    const error = new Error(
      "This assessment cannot be started in its current state."
    );

    error.status = 409;
    throw error;
  }

  const remainingSeconds =
    Number(quizSession.remaining_seconds);

  if (
    !Number.isInteger(remainingSeconds) ||
    remainingSeconds <= 0
  ) {
    await repo.quizSessions.update(sessionId, {
      status: "Timed Out",
      end_time: now,
      remaining_seconds: 0,
    });

    const error = new Error(
      "The assessment time has expired."
    );

    error.status = 409;
    error.code = "ASSESSMENT_TIME_EXPIRED";

    throw error;
  }

  // ------------------------------------------------------------
  // Final Assessment clock starts here
  // ------------------------------------------------------------
  const newDeadline = new Date(
    now.getTime() +
    remainingSeconds * 1000
  );

  await repo.quizSessions.update(sessionId, {
    status: "In Progress",
    deadline_at: newDeadline,
    paused_at: null,
  });

  return {
    activated: true,
    session_id: sessionId,
    remaining_seconds: remainingSeconds,
    deadline_at: newDeadline,
  };
}

async function pauseInitialAssessment(userId, sessionId) {

  console.log(
  "[Pause Initial Assessment] Request received:",
  {
    userId,
    sessionId,
    time: new Date().toISOString(),
  }
);
  const quizSession =
    await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error(
      "Quiz session not found"
    );

    error.status = 404;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * VERIFY OWNERSHIP
   * ----------------------------------------------------------
   */
  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );

    error.status = 403;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * ALREADY COMPLETED
   * ----------------------------------------------------------
   */
  if (quizSession.status === "Completed") {
    const error = new Error(
      "This assessment has already been completed."
    );

    error.status = 409;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * ALREADY TIMED OUT
   * ----------------------------------------------------------
   */
  if (quizSession.status === "Timed Out") {
    const error = new Error(
      "This assessment has already expired."
    );

    error.status = 409;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * ALREADY PAUSED
   *
   * Make the endpoint idempotent.
   *
   * If React accidentally calls pause twice, we don't
   * recalculate or destroy the saved remaining time.
   * ----------------------------------------------------------
   */
  if (quizSession.status === "Paused") {
    return {
      paused: true,

      session_id:
        quizSession.session_id,

      remaining_seconds:
        Number(quizSession.remaining_seconds || 0),

      paused_at:
        quizSession.paused_at,

      current_question_id:
        quizSession.current_question_id,
    };
  }

  /*
   * ----------------------------------------------------------
   * ONLY "In Progress" CAN BE PAUSED
   * ----------------------------------------------------------
   */
  if (quizSession.status !== "In Progress") {
    const error = new Error(
      "This assessment cannot be paused in its current state."
    );

    error.status = 409;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * TIMER MUST EXIST
   * ----------------------------------------------------------
   */
  if (!quizSession.deadline_at) {
    const error = new Error(
      "Assessment timer information is missing."
    );

    error.status = 500;
    throw error;
  }

  const now = new Date();

  const deadlineTime =
    new Date(
      quizSession.deadline_at
    ).getTime();

  /*
   * Calculate remaining time using SERVER TIME.
   *
   * The browser's timer is NOT trusted.
   */
  const remainingSeconds = Math.max(
    0,
    Math.floor(
      (deadlineTime - now.getTime()) / 1000
    )
  );

  /*
   * ----------------------------------------------------------
   * TIMER EXPIRED BEFORE PAUSE
   * ----------------------------------------------------------
   */
  if (remainingSeconds <= 0) {
    await repo.quizSessions.update(
      sessionId,
      {
        status: "Timed Out",
        end_time: now,
        remaining_seconds: 0,
        deadline_at: null,
      }
    );

    const error = new Error(
      "The assessment time has expired."
    );

    error.status = 409;
    error.code =
      "ASSESSMENT_TIME_EXPIRED";

    throw error;
  }

  /*
   * ----------------------------------------------------------
   * SAVE PAUSED STATE
   * ----------------------------------------------------------
   *
   * Example:
   *
   * deadline = 10:30
   * current time = 10:15
   *
   * remaining_seconds = 900
   *
   * We remove the old deadline because the assessment
   * is no longer actively counting down.
   */
  await repo.quizSessions.update(
    sessionId,
    {
      status: "Paused",

      remaining_seconds:
        remainingSeconds,

      paused_at: now,

      deadline_at: null,
    }
  );

  return {
    paused: true,

    session_id:
      quizSession.session_id,

    remaining_seconds:
      remainingSeconds,

    paused_at: now,

    current_question_id:
      quizSession.current_question_id,
  };
}

// Pause Final Assessment
async function pauseFinalAssessment(userId, sessionId) {
  const quizSession =
    await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error(
      "Quiz session not found"
    );

    error.status = 404;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * VERIFY OWNERSHIP
   * ----------------------------------------------------------
   */
  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );

    error.status = 403;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * VERIFY FINAL ASSESSMENT
   * ----------------------------------------------------------
   */
  if (quizSession.assessment_type !== "FINAL") {
    const error = new Error(
      "This session does not belong to the Final Assessment."
    );

    error.status = 409;
    error.code = "INVALID_ASSESSMENT_TYPE";
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * ALREADY COMPLETED
   * ----------------------------------------------------------
   */
  if (quizSession.status === "Completed") {
    const error = new Error(
      "This assessment has already been completed."
    );

    error.status = 409;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * ALREADY TIMED OUT
   * ----------------------------------------------------------
   */
  if (quizSession.status === "Timed Out") {
    const error = new Error(
      "This assessment has already expired."
    );

    error.status = 409;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * ALREADY PAUSED
   * ----------------------------------------------------------
   *
   * Keep the endpoint idempotent.
   */
  if (quizSession.status === "Paused") {
    return {
      paused: true,

      session_id:
        quizSession.session_id,

      remaining_seconds:
        Number(quizSession.remaining_seconds || 0),

      paused_at:
        quizSession.paused_at,

      current_question_id:
        quizSession.current_question_id,
    };
  }

  /*
   * ----------------------------------------------------------
   * ONLY "In Progress" CAN BE PAUSED
   * ----------------------------------------------------------
   */
  if (quizSession.status !== "In Progress") {
    const error = new Error(
      "This assessment cannot be paused in its current state."
    );

    error.status = 409;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * TIMER MUST EXIST
   * ----------------------------------------------------------
   */
  if (!quizSession.deadline_at) {
    const error = new Error(
      "Assessment timer information is missing."
    );

    error.status = 500;
    throw error;
  }

  const now = new Date();

  const deadlineTime =
    new Date(
      quizSession.deadline_at
    ).getTime();

  /*
   * Calculate remaining time using SERVER TIME.
   */
  const remainingSeconds = Math.max(
    0,
    Math.floor(
      (deadlineTime - now.getTime()) / 1000
    )
  );

  /*
   * ----------------------------------------------------------
   * TIMER EXPIRED BEFORE PAUSE
   * ----------------------------------------------------------
   */
  if (remainingSeconds <= 0) {
    await repo.quizSessions.update(
      sessionId,
      {
        status: "Timed Out",
        end_time: now,
        remaining_seconds: 0,
        deadline_at: null,
      }
    );

    const error = new Error(
      "The assessment time has expired."
    );

    error.status = 409;
    error.code =
      "ASSESSMENT_TIME_EXPIRED";

    throw error;
  }

  /*
   * ----------------------------------------------------------
   * SAVE PAUSED STATE
   * ----------------------------------------------------------
   */
  await repo.quizSessions.update(
    sessionId,
    {
      status: "Paused",

      remaining_seconds:
        remainingSeconds,

      paused_at: now,

      deadline_at: null,
    }
  );

  return {
    paused: true,

    session_id:
      quizSession.session_id,

    remaining_seconds:
      remainingSeconds,

    paused_at: now,

    current_question_id:
      quizSession.current_question_id,
  };
}

async function heartbeatInitialAssessment(userId, sessionId) {
  const quizSession =
    await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error(
      "Quiz session not found"
    );

    error.status = 404;
    throw error;
  }

  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );

    error.status = 403;
    throw error;
  }

  if (quizSession.status !== "In Progress") {
    return {
      active: false,
      status: quizSession.status,
      remaining_seconds: Number(
        quizSession.remaining_seconds || 0
      ),
    };
  }

  if (!quizSession.deadline_at) {
    const error = new Error(
      "Assessment timer information is missing."
    );

    error.status = 500;
    throw error;
  }

  const now = new Date();

  const remainingSeconds = Math.max(
    0,
    Math.floor(
      (
        new Date(
          quizSession.deadline_at
        ).getTime() -
        now.getTime()
      ) / 1000
    )
  );

  /*
   * Timer expired.
   */
  if (remainingSeconds <= 0) {
    await repo.quizSessions.update(
      sessionId,
      {
        status: "Timed Out",
        end_time: now,
        remaining_seconds: 0,
      }
    );

    const error = new Error(
      "The assessment time has expired."
    );

    error.status = 409;
    error.code =
      "ASSESSMENT_TIME_EXPIRED";

    throw error;
  }

  /*
   * Keep the persisted value synchronized with the
   * server-authoritative deadline.
   */
  await repo.quizSessions.update(
    sessionId,
    {
      remaining_seconds:
        remainingSeconds,
    }
  );

  return {
    active: true,

    session_id:
      sessionId,

    remaining_seconds:
      remainingSeconds,

    deadline_at:
      quizSession.deadline_at,

    current_question_id:
      quizSession.current_question_id,
  };
}

// ---------------------------------------------------------------------
// Heartbeat Final Assessment
// ---------------------------------------------------------------------
async function heartbeatFinalAssessment(userId, sessionId) {
  const quizSession =
    await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error(
      "Quiz session not found"
    );

    error.status = 404;
    throw error;
  }

  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );

    error.status = 403;
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * VERIFY FINAL ASSESSMENT
   * ----------------------------------------------------------
   */
  if (quizSession.assessment_type !== "FINAL") {
    const error = new Error(
      "This session does not belong to the Final Assessment."
    );

    error.status = 409;
    error.code = "INVALID_ASSESSMENT_TYPE";
    throw error;
  }

  /*
   * ----------------------------------------------------------
   * NOT CURRENTLY ACTIVE
   * ----------------------------------------------------------
   *
   * Completed / Paused / Timed Out / Terminated sessions
   * simply report their current state.
   */
  if (quizSession.status !== "In Progress") {
    return {
      active: false,

      status:
        quizSession.status,

      remaining_seconds:
        Number(
          quizSession.remaining_seconds || 0
        ),
    };
  }

  /*
   * ----------------------------------------------------------
   * TIMER MUST EXIST
   * ----------------------------------------------------------
   */
  if (!quizSession.deadline_at) {
    const error = new Error(
      "Assessment timer information is missing."
    );

    error.status = 500;
    throw error;
  }

  const now = new Date();

  const remainingSeconds = Math.max(
    0,
    Math.floor(
      (
        new Date(
          quizSession.deadline_at
        ).getTime() -
        now.getTime()
      ) / 1000
    )
  );

  /*
   * ----------------------------------------------------------
   * TIMER EXPIRED
   * ----------------------------------------------------------
   */
  if (remainingSeconds <= 0) {
    await repo.quizSessions.update(
      sessionId,
      {
        status: "Timed Out",
        end_time: now,
        remaining_seconds: 0,
      }
    );

    const error = new Error(
      "The assessment time has expired."
    );

    error.status = 409;
    error.code =
      "ASSESSMENT_TIME_EXPIRED";

    throw error;
  }

  /*
   * ----------------------------------------------------------
   * SYNCHRONIZE REMAINING TIME
   * ----------------------------------------------------------
   *
   * The server deadline remains authoritative.
   */
  await repo.quizSessions.update(
    sessionId,
    {
      remaining_seconds:
        remainingSeconds,
    }
  );

  return {
    active: true,

    session_id:
      sessionId,

    remaining_seconds:
      remainingSeconds,

    deadline_at:
      quizSession.deadline_at,

    current_question_id:
      quizSession.current_question_id,
  };
}

// Submit one answer, advance state, and (when a skill finishes) roll
async function submitInitialAssessmentAnswer(
  userId,
  sessionId,
  questionId,
  answer
) {
  const quizSession = await repo.quizSessions.findById(sessionId);

  if (!quizSession) {
    const error = new Error("Quiz session not found");
    error.status = 404;
    throw error;
  }

  if (quizSession.user_id !== userId) {
    const error = new Error(
      "You are not authorized to access this quiz session"
    );
    error.status = 403;
    throw error;
  }

  if (quizSession.status !== "In Progress") {
    const error = new Error("This quiz session is already completed");
    error.status = 409;
    throw error;
  }

  const now = new Date();

  if (
    quizSession.deadline_at &&
    now >= new Date(quizSession.deadline_at)
  ) {
    await repo.quizSessions.update(sessionId, {
      status: "Timed Out",
      end_time: now,
    });

    const error = new Error(
      "The assessment time has expired."
    );

    error.status = 409;
    error.code = "ASSESSMENT_TIME_EXPIRED";

    throw error;
  }

  const skillId = quizSession.current_skill_id;
  if (!skillId) {
    const error = new Error(
      "Current skill is not available for this quiz session"
    );
    error.status = 400;
    throw error;
  }

  const question = await repo.questions.findById(questionId);

  if (!question) {
    const error = new Error("Question not found");
    error.status = 404;
    throw error;
  }

  if (
    question.assessment_type !==
    quizSession.assessment_type
  ) {
    const error = new Error(
      "This question does not belong to this assessment"
    );

    error.status = 400;
    throw error;
  }

  if (question.skill_id !== skillId) {
    const error = new Error(
      "This question does not belong to the current skill"
    );
    error.status = 400;
    throw error;
  }

  if (quizSession.current_question_id !== questionId) {
    const error = new Error(
      "This is not the current question"
    );
    error.status = 400;
    throw error
  }

  const stateRow = await repo.quizStates.findById(sessionId, skillId);

  if (!stateRow || !stateRow.state) {
    const error = new Error("Quiz state not found");
    error.status = 404;
    throw error;
  }

  const state = stateRow.state;

  const aiQuestion = {
    question_id: question.question_id,
    difficulty_id: question.difficulty_id,
    correct_option: question.correct_option,
    marks: question.marks
  };

  const submitResponse = await adaptiveQuizService.submitAnswer({
    state,
    question: aiQuestion,
    selected_option: answer,
  });

  const result = submitResponse.result;
  const updatedState = result.updated_state;

  await repo.quizStates.update(sessionId, skillId, {
    current_difficulty: updatedState.current_difficulty,
    correct_streak: updatedState.correct_streak,
    wrong_streak: updatedState.wrong_streak,
    questions_answered: updatedState.questions_answered,
    obtained_score: updatedState.obtained_score,
    maximum_score: updatedState.maximum_score,
    state: updatedState,
  });

  await repo.studentAnswers.create({
    session_id: sessionId,
    skill_id: skillId,
    question_id: questionId,
    difficulty_id: question.difficulty_id,
    selected_option: answer,
    correct_option: question.correct_option,
    is_correct: result.is_correct,
    marks_awarded: result.marks_awarded,
  });

  await repo.quizSessions.update(sessionId, {
    questions_answered: (quizSession.questions_answered || 0) + 1,
  });

  const requiredSkills = await repo.domainRequiredSkills.findByDomainRoleId(
    quizSession.domain_role_id
  );

  const skillOrder = [
    "Python",
    "SQL",
    "Machine Learning",
    "Deep Learning",
    "Git",
  ];

  requiredSkills.sort((a, b) => {
    const indexA = skillOrder.indexOf(a.skill.skill_name);
    const indexB = skillOrder.indexOf(b.skill.skill_name);

    return indexA - indexB;
  });
  const completedResults = await repo.studentSkillResults.findBySessionId(
    sessionId
  );
  const completedSkillIds = new Set(completedResults.map((r) => r.skill_id));

  const assessmentMeta = {
    total_skills: requiredSkills.length,
    questions_per_skill: 10,
    total_questions: requiredSkills.length * 10,

    current_skill_index: requiredSkills.findIndex(
      (skill) => skill.skill_id === quizSession.current_skill_id
    ),

    overall_question: (quizSession.questions_answered || 0) + 1,

    remaining_questions:
      requiredSkills.length * 10 -
      ((quizSession.questions_answered || 0) + 1),

    skills: requiredSkills.map((item) => ({
      skill_id: item.skill_id,
      skill_name: item.skill.skill_name,

      status: completedSkillIds.has(item.skill_id)
        ? "completed"
        : item.skill_id === quizSession.current_skill_id
          ? "current"
          : "upcoming",
    })),
  };


  // Skill not finished yet — just hand back the next question
  if (!result.skill_completed) {
    const questions = await repo.questions.findBySkill(skillId, quizSession.assessment_type);

    const nextQuestionResponse = await adaptiveQuizService.getNextQuestion({
      state: updatedState,
      questions,
    });

    if (!nextQuestionResponse.question) {
      const error = new Error(
        "No next question is available"
      );

      error.status = 500;
      throw error
    }

    await repo.quizSessions.update(sessionId, {
      current_question_id: nextQuestionResponse.question.question_id,
    });

    return {
      assessment_completed: false,
      skill_completed: false,
      assessment: assessmentMeta,
      is_correct: result.is_correct,
      marks_awarded: result.marks_awarded,
      progress: {
        current: updatedState.questions_answered,
        total: assessmentMeta.questions_per_skill,
        percentage: Math.round(
          (updatedState.questions_answered /
            assessmentMeta.questions_per_skill) *
          100
        ),
      },
      question: toClientQuestion(nextQuestionResponse.question),
    };
  }

  // Skill finished — score it and store the result
  const scoreResponse = await adaptiveQuizService.calculateSkillScore({
    state: updatedState,
  });
  const score = scoreResponse.result;

  await repo.studentSkillResults.create({
    session_id: sessionId,
    skill_id: skillId,
    obtained_score: score.obtained_score,
    maximum_score: score.maximum_score,
    percentage: score.percentage,
    skill_level: score.skill_level,
  });
  completedSkillIds.add(skillId);
  completedResults.push({
    skill_id: skillId
  })

  await repo.quizStates.remove(sessionId, skillId);

  const nextRequired = requiredSkills.find(
    (rs) => !completedSkillIds.has(rs.skill_id) && rs.skill_id !== skillId
  );

  // Nothing left — assessment complete. This is the trigger point for
  // Skill Gap Analysis (Assessment Completed -> Load Results -> Load
  // Required Skills -> Python Skill Gap Engine -> ... -> Report).
  if (!nextRequired) {
    await repo.quizSessions.update(sessionId, {
      status: "Completed",
      end_time: new Date(),
    });

    if (quizSession.assessment_type === "INITIAL") {
      await repo.profiles.upsert(userId, {
        initial_assessment_completed: true,
      });
    }

   const quizReadinessScore =
    await repo.studentSkillResults.getQuizScoreBySessionId(
      sessionId
    );

    // Persist the FINAL quiz score so a later portion can compute:
    //   finalReadiness = finalQuizScore * 0.40 + miniProjectScore * 0.60
    // Only runs for FINAL assessment completion; Initial quiz is unaffected.
    if (quizSession.assessment_type === "FINAL") {
      await skillGapService.updateFinalReadiness(
        userId,
        quizReadinessScore
      );
    }

    return {
      assessment_completed: true,
      skill_completed: true,
      assessment: assessmentMeta,
      readiness_score: quizReadinessScore,
      completed_skill: score,
    };
  }

  // Move on to the next skill
  await repo.quizSessions.update(sessionId, {
    current_skill_id: nextRequired.skill_id,
  });

  const nextQuestions =
    await repo.questions.findBySkill(
      nextRequired.skill_id,
      quizSession.assessment_type
    );

  const newStateResponse = await adaptiveQuizService.createQuizState({
    session_id: sessionId,
    skill: {
      skill_id: nextRequired.skill_id,
      skill_name: nextRequired.skill.skill_name,
    },
    assessment_type: quizSession.assessment_type,
  });
  const newState = {
    ...newStateResponse.state,

    ...(quizSession.assessment_type === "FINAL"
      ? {
        current_difficulty: 2,
      }
      : {}),
  };

  await repo.quizStates.create({
    session_id: sessionId,
    skill_id: nextRequired.skill_id,
    current_difficulty: newState.current_difficulty,
    correct_streak: newState.correct_streak,
    wrong_streak: newState.wrong_streak,
    questions_answered: newState.questions_answered,
    obtained_score: newState.obtained_score,
    maximum_score: newState.maximum_score,
    state: newState,
  });

  const firstQuestionResponse = await adaptiveQuizService.getNextQuestion({
    state: newState,
    questions: nextQuestions,
  });

  if (!firstQuestionResponse.question) {
    const error = new Error("No question available for the next skill")
    error.status = 500;
    throw error;
  }

  await repo.quizSessions.update(sessionId, {
    current_skill_id: nextRequired.skill_id,
    current_question_id: firstQuestionResponse.question.question_id,
  });

  const nextAssessmentMeta = {
    total_skills: requiredSkills.length,

    questions_per_skill: 10,

    total_questions: requiredSkills.length * 10,

    current_skill_index: requiredSkills.findIndex(
      (skill) => skill.skill_id === nextRequired.skill_id
    ),

    overall_question: (quizSession.questions_answered || 0) + 1,

    remaining_questions:
      requiredSkills.length * 10 -
      ((quizSession.questions_answered || 0) + 1),

    skills: requiredSkills.map((item) => ({
      skill_id: item.skill_id,
      skill_name: item.skill.skill_name,

      status:
        completedSkillIds.has(item.skill_id)
          ? "completed"
          : item.skill_id === nextRequired.skill_id
            ? "current"
            : "upcoming",
    })),
  };

  return {
    assessment_completed: false,
    skill_completed: true,
    assessment: nextAssessmentMeta,
    completed_skill: score,
    next_skill: {
      skill_id: nextRequired.skill_id,
      skill_name: nextRequired.skill.skill_name,
    },
    question: toClientQuestion(firstQuestionResponse.question),
  };
}

// ---------------------------------------------------------------------
// Submit Final Assessment Answer
// ---------------------------------------------------------------------
async function submitFinalAssessmentAnswer(
  userId,
  sessionId,
  questionId,
  answer
) {
  return submitInitialAssessmentAnswer(
    userId,
    sessionId,
    questionId,
    answer
  );
}

async function getAssessmentOverview(userId) {
  const [initialSession, finalSession, gapReport] = await Promise.all([
    repo.quizSessions.findLatestByUserAndAssessmentType(
      userId,
      "INITIAL"
    ),

    repo.quizSessions.findLatestByUserAndAssessmentType(
      userId,
      "FINAL"
    ),

    repo.gapReports.findByUserId(userId),
  ]);

  //Get termination report
    const getTerminationEvent = async (sessionId) => {
    if (!sessionId) return null;

    const events = await repo.proctoringEvents.listBySessionId(sessionId);

    const terminationEvents = (events || []).filter(
      (event) =>
        event.action === "TERMINATE_EXAM" ||
        event.violation_type === "EXAM_TERMINATED" ||
        event.event_type === "EXAM_TERMINATED"
    );

    const event =
      terminationEvents[terminationEvents.length - 1];

    if (!event) return null;

    return {
      violationType: event.violation_type || null,
      action: event.action || null,
      severity: event.severity || null,
      message:
        event.message ||
        "Assessment was terminated.",
      createdAt: event.created_at || null,
    };
  }; 

  // ------------------------------------------------------------
  // CODING ASSESSMENT
  // ------------------------------------------------------------
  // Coding assessment belongs to the Initial Quiz session.
  // Only look it up once the Initial Quiz has been completed.
  let codingSession = null;

if (initialSession?.status === "Completed") {
  codingSession = await repo.codingSessions.findBySessionAndUser(
    initialSession.session_id,
    userId
  );
}

  const initialTerminationEvent =
    initialSession?.status === "Terminated"
      ? await getTerminationEvent(initialSession.session_id)
      : null;

  const codingTerminationEvent =
    codingSession?.status === "Terminated"
      ? await getTerminationEvent(codingSession.session_id)
      : null;

  const finalTerminationEvent =
    finalSession?.status === "Terminated"
      ? await getTerminationEvent(finalSession.session_id)
      : null;


const initialQuizCompleted = initialSession?.status === "Completed";
const codingCompleted = codingSession?.status === "Completed";

let initialAssessmentStatus = "Not Started";

if (initialQuizCompleted && codingCompleted) {
  initialAssessmentStatus = "Completed";
} else if (initialQuizCompleted) {
  initialAssessmentStatus = "In Progress";
} else if (initialSession?.status) {
  initialAssessmentStatus = initialSession.status;
}

return {
  
   initialAssessment: {
  status: initialAssessmentStatus,
initialQuizStatus: initialSession?.status || "Not Started",
  sessionId: initialSession?.session_id || null,
  questionsAnswered: initialSession?.questions_answered || 0,
  totalQuestions: initialSession?.total_questions || 0,
  readinessScore:
  initialQuizCompleted && codingCompleted
    ? gapReport?.readiness_score ?? null
    : null,
  termination: initialTerminationEvent,
},

    codingAssessment: {
  status: codingSession?.status || "Not Started",
  sessionId: codingSession?.session_id || null,
  remainingSeconds:
    Number(codingSession?.remaining_seconds || 0),
  termination: codingTerminationEvent,
},


    finalAssessment: {
      finalQuiz: {
        status: finalSession?.status || "Not Started",
        sessionId: finalSession?.session_id || null,
        questionsAnswered: finalSession?.questions_answered || 0,
        totalQuestions: finalSession?.total_questions || 0,
        termination: finalTerminationEvent,
      },

      miniProject: {
        status: "Not Available",
      },
    },
  };
}

module.exports = {
  startInitialAssessment,
  startFinalAssessment,

  activateInitialAssessment,
  activateFinalAssessment,

  pauseInitialAssessment,
  pauseFinalAssessment,

  heartbeatInitialAssessment,
  heartbeatFinalAssessment,

  submitInitialAssessmentAnswer,
  submitFinalAssessmentAnswer,

  getAssessmentOverview,


};

