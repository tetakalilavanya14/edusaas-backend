
const repo = require("../data/prismaRepo");
const { runCode, runCodeBatch } = require("./dockerService");
const skillGapService = require("./skillGapService")
const aimlClient = require("./aimlClient");
const { calculateInitialReadiness } = require("./readinessScoreService")
require('dotenv').config()
const CODING_QUESTION_COUNT = 3;

const CODING_ASSESSMENT_FORMAT = "Practical Coding";
const CODING_TEST_CONCURRENCY = Math.max(
  1,
  Number(process.env.CODING_TEST_CONCURRENCY) || 4
);

function getCodingDurationSeconds() {
  const minutes = Number(
    process.env.INITIAL_CODING_ASSESSMENT_DURATION_MINUTES || 45
  );
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("INITIAL_CODING_ASSESSMENT_DURATION_MINUTES is not configured correctly");
  }
  return Math.floor(minutes * 60);
}

async function startAssessment({ userId, sessionId }) {
  if (!userId || !sessionId) {
    const error = new Error("userId and sessionId are required");
    error.status = 400;
    throw error;
  }

  const numericSessionId = Number(sessionId);

  if (!Number.isInteger(numericSessionId)) {
    const error = new Error("Invalid sessionId");
    error.status = 400;
    throw error;
  }
  // 1. Verify that the quiz session exists
  const quizSession = await repo.quizSessions.findById(
    numericSessionId
  );

  if (!quizSession) {
    const error = new Error("Quiz session not found");
    error.status = 404;
    throw error;
  }

  // 2. Make sure this session belongs to this student
  if (String(quizSession.user_id) !== String(userId)) {
    const error = new Error(
      "You are not authorized to access this session"
    );
    error.status = 403;
    throw error;
  }

  // 3. Coding assessment can start only after quiz completion
  if (quizSession.status !== "Completed") {
    const error = new Error(
      "Initial quiz must be completed before starting the coding assessment"
    );
    error.status = 409;
    throw error;
  }

  // 4. Find existing coding session
  // IMPORTANT:
  // coding session_id == quiz session_id

  let codingSession =
    await repo.codingSessions.findBySessionAndUser(
      numericSessionId,
      userId
    );
  console.log("CODING SESSION LOOKUP:", {
    numericSessionId,
    userId,
    codingSession,
  });

  // 5. First time entering coding assessment
  if (!codingSession) {
    const durationSeconds = getCodingDurationSeconds();
    const startedAt = new Date();
    try {
      codingSession = await repo.codingSessions.create({
        session_id: numericSessionId,
        user_id: userId,
        status: "Paused",
        started_at: startedAt,
        deadline_at: null,
        remaining_seconds: durationSeconds,
      });
    } catch (error) {
      if (error.code !== "P2002") {
        throw error;
      }

      codingSession =
        await repo.codingSessions.findBySessionAndUser(
          numericSessionId,
          userId
        );

      if (!codingSession) {
        throw error;
      }
    }
  }

  // ---------------------------------------------------------
  // 6. Existing coding session = resume
  //
  // NEVER reset the original deadline.
  // ---------------------------------------------------------

  else {
    if (codingSession.status === "Completed") {
      const error = new Error(
        "Coding assessment has already been completed"
      );
      error.status = 409;
      throw error;
    }

    // -------------------------------------------------------
    // PAUSED sessions have no active deadline (deadline_at is
    // cleared on pause) — the persisted remaining_seconds is
    // authoritative here and must NOT be recomputed from a null
    // deadline (that previously produced remainingSeconds = 0
    // and incorrectly flipped every resumed session to "Timed
    // Out"). Leave the session paused; the student must call
    // /initial-coding/activate to actually resume the clock,
    // mirroring the initial quiz's start/activate split.
    // -------------------------------------------------------
    if (codingSession.status === "Paused") {
      codingSession = {
        ...codingSession,
        remaining_seconds: Number(
          codingSession.remaining_seconds || 0
        ),
      };
    } else {
      // "In Progress" (or any other clock-bearing state) — the
      // deadline is authoritative.
      const remainingSeconds = codingSession.deadline_at
        ? Math.max(
            0,
            Math.floor(
              (new Date(codingSession.deadline_at).getTime() -
                Date.now()) /
                1000
            )
          )
        : 0;

      if (remainingSeconds <= 0) {
        await repo.codingSessions.update(
          numericSessionId,
          {
            status: "Timed Out",
            remaining_seconds: 0,
            completed_at: new Date(),
          }
        );

        const error = new Error(
          "Coding assessment time has expired"
        );
        error.status = 409;
        throw error;
      }

      codingSession = {
        ...codingSession,
        remaining_seconds: remainingSeconds,
      };
    }
  }

  // ---------------------------------------------------------
  // 7. Get questions already assigned to this student
  // ---------------------------------------------------------

  let askedQuestions =
    (await repo.studentAskedQuestions.listRecentByUser(
      userId,
      CODING_QUESTION_COUNT
    )) || [];

  // ---------------------------------------------------------
  // 8. Assign additional questions if required
  // ---------------------------------------------------------

  if (askedQuestions.length < CODING_QUESTION_COUNT) {
    const askedQuestionIds =
      (await repo.studentAskedQuestions.findAskedQuestionIds(
        userId
      )) || [];

    const requiredCount =
      CODING_QUESTION_COUNT - askedQuestions.length;

    const newQuestions =
      (await repo.codingQuestions.findUnseen(
        askedQuestionIds,
        requiredCount
      )) || [];

    if (newQuestions.length > 0) {
      await repo.studentAskedQuestions.createMany(
        newQuestions.map((question) => ({
          user_id: userId,
          question_id: question.question_id,
        }))
      );
    }

    // Reload after assignment
    askedQuestions =
      (await repo.studentAskedQuestions.listRecentByUser(
        userId,
        CODING_QUESTION_COUNT
      )) || [];
  }

  // ---------------------------------------------------------
  // 9. Load complete question records
  // ---------------------------------------------------------

  const questionIds = askedQuestions.map(
    (item) => item.question_id
  );

  const questionRecords =
    (await repo.codingQuestions.findByIds(questionIds)) || [];

  if (questionRecords.length !== questionIds.length) {
    const error = new Error(
      "One or more assigned coding questions could not be loaded"
    );
    error.status = 500;
    throw error;
  }

  const questionMap = new Map(
    questionRecords.map((question) => [
      question.question_id,
      question,
    ])
  );

  const orderedQuestions = questionIds
    .map((id) => questionMap.get(id))
    .filter(Boolean);

  if (!orderedQuestions.length) {
    const error = new Error(
      "No coding questions are available for this assessment"
    );
    error.status = 404;
    throw error;
  }

  // ---------------------------------------------------------
  // 10. Load the student's most recent submission for each
  // assigned question (if any) so the frontend can restore
  // exactly what the student last wrote/submitted instead of
  // showing a blank editor whenever a question is revisited.
  // ---------------------------------------------------------

  const existingSubmissions =
    (await repo.codingSubmissions.findBySessionId(
      numericSessionId
    )) || [];

  // findBySessionId already orders by submitted_at desc, so the
  // first submission encountered per question is the latest one.
  const latestSubmissionByQuestion = new Map();

  for (const submission of existingSubmissions) {
    if (!latestSubmissionByQuestion.has(submission.question_id)) {
      latestSubmissionByQuestion.set(
        submission.question_id,
        submission
      );
    }
  }

  // ---------------------------------------------------------
  // 11. Return coding assessment
  // ---------------------------------------------------------

  return {
  assessment: {
    questionCount: orderedQuestions.length,
    format: CODING_ASSESSMENT_FORMAT,
  },

  session: {
    sessionId: codingSession.session_id,
    userId: codingSession.user_id,
    status: codingSession.status,
    totalScore: Number(
      codingSession.total_score || 0
    ),
    maxScore: Number(
      codingSession.max_score || 300
    ),
    questionsCompleted:
      codingSession.questions_completed || 0,
    startedAt: codingSession.started_at,
    deadlineAt: codingSession.deadline_at,
    remainingSeconds:
      codingSession.remaining_seconds,
  },

  questions: orderedQuestions.map(
      (question, index) => {
        const lastSubmission = latestSubmissionByQuestion.get(
          question.question_id
        );

        return {
          order: index + 1,

          questionId: question.question_id,

          title: question.title,

          description: question.description,

          inputFormat: question.input_format,

          outputFormat: question.output_format,

          constraints:
            question.constraints_text,

          supportedLanguages:
            question.supported_languages,

          timeLimitMs:
            question.default_time_limit_ms,

          memoryLimitMb:
            question.default_memory_limit_mb,

          totalMarks:
            Number(question.total_marks || 100),

          sampleTestCases:
            (question.coding_test_cases || [])
              .filter(
                (testCase) =>
                  !testCase.is_hidden
              )
              .map((testCase) => ({
                testCaseId:
                  testCase.test_case_id,

                inputData:
                  testCase.input_data,

                expectedOutput:
                  testCase.expected_output,
              })),

          // Lets the client restore the student's last saved
          // attempt for this question (code, language, score)
          // instead of resetting the editor every time the
          // question loses focus. `null` when never submitted.
          lastSubmission: lastSubmission
            ? {
                language: lastSubmission.language,
                code: lastSubmission.source_code,
                status: lastSubmission.status,
                score: Number(lastSubmission.score || 0),
                totalMarks: Number(
                  lastSubmission.total_marks ||
                    question.total_marks ||
                    100
                ),
                passedTestCases:
                  lastSubmission.passed_test_cases,
                totalTestCases:
                  lastSubmission.total_test_cases,
                submittedAt: lastSubmission.submitted_at,
              }
            : null,
        };
      }
    ),
  };
}

async function executeTestCases(testCases, language, code) {
  const results = [];

  for (let i = 0; i < testCases.length; i += 4) {
    const batch = testCases.slice(i, i + 4);

    const batchResults = await Promise.all(
      batch.map(async (testCase) => {
        const execution = await runCode(
          language,
          code,
          testCase.input_data || ""
        );

        const actualOutput =
          execution.stdout == null
            ? ""
            : String(execution.stdout).trim();

        const expectedOutput =
          testCase.expected_output == null
            ? ""
            : String(testCase.expected_output).trim();

        let status;

        if (execution.status === "timeout") {
          status = "TIMEOUT";
        } else if (execution.status === "runtime_error") {
          status = "RUNTIME_ERROR";
        } else if (
          execution.status === "success" &&
          actualOutput === expectedOutput
        ) {
          status = "PASSED";
        } else {
          status = "FAILED";
        }

        return {
          testCaseId: testCase.test_case_id,
          status,
          actualOutput,
          expectedOutput,
          executionTimeMs: execution.executionTime || 0,
          errorMessage:
            execution.status === "success"
              ? null
              : execution.stderr || null,
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
}

async function runStudentCode({
  userId,
  session_id,
  question_id,
  language,
  code,
}) {
  // ---------------------------------------------------------
  // 1. Validate request
  // ---------------------------------------------------------

  if (!userId) {
    const error = new Error("userId is required");
    error.status = 400;
    throw error;
  }

  if (session_id === undefined) {
    const error = new Error("session_id is required");
    error.status = 400;
    throw error;
  }

  if (question_id === undefined) {
    const error = new Error("question_id is required");
    error.status = 400;
    throw error;
  }

  if (!language || typeof language !== "string") {
    const error = new Error("language is required");
    error.status = 400;
    throw error;
  }

  if (!code || typeof code !== "string") {
    const error = new Error("code is required");
    error.status = 400;
    throw error;
  }

  const sessionId = Number(session_id);
  const questionId = Number(question_id);

  if (!Number.isInteger(sessionId)) {
    const error = new Error("session_id must be a valid integer");
    error.status = 400;
    throw error;
  }

  if (!Number.isInteger(questionId)) {
    const error = new Error("question_id must be a valid integer");
    error.status = 400;
    throw error;
  }

  // ---------------------------------------------------------
  // 2. Verify coding session belongs to current student
  // ---------------------------------------------------------

  const [codingSession, askedQuestion] = await Promise.all([
    repo.codingSessions.findBySessionAndUser(
      sessionId,
      userId
    ),
    repo.studentAskedQuestions.find(
      userId,
      questionId
    ),
  ]);

  if (!codingSession) {
    const error = new Error("Coding assessment session not found");
    error.status = 404;
    throw error;
  }

  // ---------------------------------------------------------
  // Verify that this question is actually assigned to
  // this student for the coding assessment
  // ---------------------------------------------------------

  if (!askedQuestion) {
    const error = new Error(
      "This coding question is not assigned to this student"
    );
    error.status = 403;
    throw error;
  }

  // ---------------------------------------------------------
  // 3. Verify session is still active
  // ---------------------------------------------------------

  if (codingSession.status === "Completed") {
    const error = new Error(
      "Coding assessment has already been completed"
    );
    error.status = 409;
    throw error;
  }

  if (codingSession.status === "Timed Out") {
    const error = new Error(
      "Coding assessment time has expired"
    );
    error.status = 409;
    throw error;
  }

  // ---------------------------------------------------------
  // 4. Check server-side deadline
  // ---------------------------------------------------------

  if (
    codingSession.deadline_at &&
    new Date(codingSession.deadline_at).getTime() <= Date.now()
  ) {
    await repo.codingSessions.update(sessionId, {
      status: "Timed Out",
      remaining_seconds: 0,
      completed_at: new Date(),
    });

    const error = new Error(
      "Coding assessment time has expired"
    );
    error.status = 409;
    throw error;
  }

  // ---------------------------------------------------------
  // 5. Load question from database
  //
  // Never trust question/test-case information from frontend.
  // ---------------------------------------------------------

  const question =
    await repo.codingQuestions.findById(questionId);

  if (!question) {
    const error = new Error("Coding question not found");
    error.status = 404;
    throw error;
  }

  // ---------------------------------------------------------
  // 7. Validate language against question's allowed languages
  // ---------------------------------------------------------

  const normalizedLanguage = language.trim().toLowerCase();

  const supportedLanguages =
    Array.isArray(question.supported_languages)
      ? question.supported_languages.map((item) =>
          String(item).trim().toLowerCase()
        )
      : [];

  const languageAliases = {
    py: "python",
    "c++": "cpp",
    js: "javascript",
  };

  const canonicalLanguage =
    languageAliases[normalizedLanguage] ||
    normalizedLanguage;

  const normalizedSupportedLanguages =
    supportedLanguages.map(
      (item) => languageAliases[item] || item
    );

  if (
    !normalizedSupportedLanguages.includes(
      canonicalLanguage
    )
  ) {
    const error = new Error(
      `Language '${language}' is not supported for this question`
    );
    error.status = 400;
    throw error;
  }

  // ---------------------------------------------------------
  // 8. Execute ONLY against a server-controlled sample input
  //
  // run endpoint is for testing code before final submission.
  // It must NOT run hidden test cases.
  // ---------------------------------------------------------

  const sampleTestCases =
    (question.coding_test_cases || []).filter(
      (testCase) => !testCase.is_hidden
    );

  if (sampleTestCases.length === 0) {
    const error = new Error(
      "No sample test cases are available for this question"
    );
    error.status = 500;
    throw error;
  }

  // ---------------------------------------------------------
  // 9. Run code against sample test cases
  // ---------------------------------------------------------
  
  const executions = await runCodeBatch(
      canonicalLanguage,
      code,
      sampleTestCases.map((testCase) => testCase.input_data || ""),
      CODING_TEST_CONCURRENCY
  );

  const results = sampleTestCases.map((testCase, index) => {
      const execution = executions[index];

      const actualOutput =
          execution?.stdout === undefined ||
          execution?.stdout === null
              ? ""
              : String(execution.stdout).trim();

      const expectedOutput =
          testCase.expected_output === undefined ||
          testCase.expected_output === null
              ? ""
              : String(testCase.expected_output).trim();

      const passed =
          execution?.status === "success" &&
          actualOutput === expectedOutput;

      return {
          testCaseId: testCase.test_case_id,
          passed,
          expectedOutput,
          actualOutput,
          status: execution?.status || "runtime_error",
          stderr: execution?.stderr || "",
          exitCode: execution?.exitCode ?? null,
          executionTime: execution?.executionTime || 0,
      };
});
 

  // ---------------------------------------------------------
  // 10. Return execution result
  //
  // IMPORTANT:
  // This does NOT create a submission.
  // The submission endpoint handles persistence.
  // ---------------------------------------------------------

  const passedCount =
    results.filter((result) => result.passed).length;

  return {
    status: "success",

    sessionId: sessionId,

    questionId: questionId,

    language: canonicalLanguage,

    passedCount,

    totalTestCases: results.length,

    results,
  };
}

async function submitCode({
  userId,
  sessionId,
  questionId,
  language,
  code,
}) {
  // ---------------------------------------------------------
  // 1. Validate required input
  // ---------------------------------------------------------

  if (!userId || !sessionId || !questionId || !language || !code) {
    const error = new Error(
      "userId, sessionId, questionId, language and code are required"
    );
    error.status = 400;
    throw error;
  }

  const numericSessionId = Number(sessionId);
  const numericQuestionId = Number(questionId);

  if (!Number.isInteger(numericSessionId)) {
    const error = new Error("Invalid sessionId");
    error.status = 400;
    throw error;
  }

  if (!Number.isInteger(numericQuestionId)) {
    const error = new Error("Invalid questionId");
    error.status = 400;
    throw error;
  }

  // ---------------------------------------------------------
  // 2. Verify coding session belongs to this student
  // ---------------------------------------------------------

  const [codingSession, askedQuestion, question, testCases] =
    await Promise.all([
      repo.codingSessions.findBySessionAndUser(
        numericSessionId,
        userId
      ),
      repo.studentAskedQuestions.find(
        userId,
        numericQuestionId
      ),
      repo.codingQuestions.findById(
        numericQuestionId
      ),
      repo.codingTestCases.findByQuestionId(
        numericQuestionId
      ),
    ]);

  if (!codingSession) {
    const error = new Error("Coding session not found");
    error.status = 404;
    throw error;
  }

  if (!askedQuestion) {
    const error = new Error(
      "This coding question is not assigned to this student"
    );
    error.status = 403;
    throw error;
  }

  // ---------------------------------------------------------
  // 3. Submission is allowed only while assessment is active
  // ---------------------------------------------------------

  if (codingSession.status !== "In Progress") {
    const error = new Error(
      "Coding assessment is no longer in progress"
    );
    error.status = 409;
    throw error;
  }

  // ---------------------------------------------------------
  // 4. Enforce server-side coding deadline
  // ---------------------------------------------------------

  if (
    codingSession.deadline_at &&
    new Date(codingSession.deadline_at).getTime() <= Date.now()
  ) {
    await repo.codingSessions.update(
      numericSessionId,
      {
        status: "Timed Out",
        remaining_seconds: 0,
        completed_at: new Date(),
      }
    );

    const error = new Error(
      "Coding assessment time has expired"
    );
    error.status = 409;
    throw error;
  }

  // ---------------------------------------------------------
  // 5. Load question
  // ---------------------------------------------------------

  if (!question) {
    const error = new Error("Coding question not found");
    error.status = 404;
    throw error;
  }

  // ---------------------------------------------------------
  // 6. Validate selected language
  // ---------------------------------------------------------

    const supportedLanguages =
    Array.isArray(question.supported_languages)
      ? question.supported_languages.map((item) =>
          String(item).trim().toLowerCase()
        )
      : [];

  const normalizedLanguage =
    language.trim().toLowerCase();

  const languageAliases = {
    py: "python",
    "c++": "cpp",
    js: "javascript",
  };

  const canonicalLanguage =
    languageAliases[normalizedLanguage] ||
    normalizedLanguage;

  const normalizedSupportedLanguages =
    supportedLanguages.map(
      (item) => languageAliases[item] || item
    );

  if (
    !normalizedSupportedLanguages.includes(
      canonicalLanguage
    )
  ) {
    const error = new Error(
      `Language '${language}' is not supported for this question`
    );
    error.status = 400;
    throw error;
  }

  // ---------------------------------------------------------
  // 7. Load ALL test cases
  //
  // Unlike runStudentCode(), submitCode() evaluates both
  // visible and hidden test cases.
  // ---------------------------------------------------------

  if (!testCases.length) {
    const error = new Error(
      "No test cases configured for this question"
    );
    error.status = 500;
    throw error;
  }

  // ---------------------------------------------------------
  // 8. Execute code against every test case
  // ---------------------------------------------------------
    const executions = await runCodeBatch(
      canonicalLanguage,
      code,
      testCases.map((testCase) => testCase.input_data || ""),
      Math.max(1, Math.min(Number(CODING_TEST_CONCURRENCY) || 4, testCases.length))
    );

    const testResults = testCases.map((testCase, index) => {
        const execution = executions[index];

        const actualOutput =
            execution?.stdout
                ? String(execution.stdout).trim()
                : "";

        const expectedOutput =
            testCase.expected_output
                ? String(testCase.expected_output).trim()
                : "";

        let resultStatus;

        if (execution?.status === "timeout") {
            resultStatus = "TIMEOUT";
        } else if (execution?.status === "compile_error") {
            resultStatus = "COMPILATION_ERROR";
        } else if (execution?.status === "runtime_error") {
            resultStatus = "RUNTIME_ERROR";
        } else if (
            execution?.status === "success" &&
            actualOutput === expectedOutput
        ) {
            resultStatus = "PASSED";
        } else {
            resultStatus = "FAILED";
        }

        return {
            testCaseId: testCase.test_case_id,
            status: resultStatus,
            actualOutput,
            expectedOutput,
            executionTimeMs:
                execution?.executionTime || 0,
            errorMessage:
                execution?.status === "success"
                    ? null
                    : execution?.stderr || null,
        };
    });

  // ---------------------------------------------------------
  // 9. Calculate score
  //
  // Test-case weights come from coding_test_cases.weight.
  // If weight is missing, use 1.
  // ---------------------------------------------------------

  let totalWeight = 0;
  let passedWeight = 0;

  for (const testCase of testCases) {
    const weight = Number(testCase.weight || 1);

    totalWeight += weight;

    const result = testResults.find(
      (item) =>
        item.testCaseId === testCase.test_case_id
    );

    if (result && result.status === "PASSED") {
      passedWeight += weight;
    }
  }

  const totalMarks = Number(
    question.total_marks || 100
  );

  const score =
    totalWeight > 0
      ? Number(
          ((passedWeight / totalWeight) * totalMarks).toFixed(2)
        )
      : 0;

  const passedTestCases =
    testResults.filter(
      (result) => result.status === "PASSED"
    ).length;

  const totalTestCases = testResults.length;

  const executionTimes = testResults.map(
    (result) => result.executionTimeMs || 0
  );

  const executionTimeMs =
    executionTimes.length
      ? Math.max(...executionTimes)
      : 0;

  // ---------------------------------------------------------
  // 10. Determine overall submission status
  // ---------------------------------------------------------

  let submissionStatus = "Wrong Answer";

  if (passedTestCases === totalTestCases) {
    submissionStatus = "Accepted";
  } else if (
    testResults.some(
      (result) => result.status === "TIMEOUT"
    )
  ) {
    submissionStatus = "Time Limit Exceeded";
  } else if (
    testResults.some(
      (result) => result.status === "COMPILATION_ERROR"
    )
  ) {
    submissionStatus = "Compilation Error";
  } else if (
    testResults.some(
      (result) =>
        result.status === "RUNTIME_ERROR"
    )
  ) {
    submissionStatus = "Runtime Error";
  }

  // ---------------------------------------------------------
  // 11. Persist submission
  // ---------------------------------------------------------

  const submission =
    await repo.codingSubmissions.create({
      user_id: userId,
      session_id: numericSessionId,
      question_id: numericQuestionId,
      language: canonicalLanguage,
      source_code: code,
      status: submissionStatus,
      score,
      total_marks: totalMarks,
      passed_test_cases: passedTestCases,
      total_test_cases: totalTestCases,
      execution_time_ms: executionTimeMs,
    });

  // ---------------------------------------------------------
  // 11.5 Trigger Code Plagiarism Check
  // ---------------------------------------------------------
  try {
    const rawComparisons = await repo.codingSubmissions.getComparisonSubmissions(numericQuestionId, userId);
    const comparison_submissions = (rawComparisons || []).map(sub => ({
      submission_id: sub.submission_id,
      code: sub.source_code
    }));

    const plagiarismResp = await aimlClient.checkCodePlagiarism({
      language: canonicalLanguage,
      submission: {
        submission_id: submission.submission_id,
        code: code
      },
      comparison_submissions: comparison_submissions
    });
    
    const matches = (plagiarismResp && (plagiarismResp.matches || plagiarismResp.data?.matches)) || [];
    const comparisonCount = (plagiarismResp && (plagiarismResp.comparison_count ?? plagiarismResp.data?.comparison_count)) || 0;

    if (matches.length > 0) {
      const highestSimilarity = Math.max(...matches.map((m) => Number(m.final_similarity || 0)), 0);
      const highRiskMatches = matches.filter(
        (m) => m.risk_level === "HIGH" || m.risk_level === "VERY_HIGH"
      );

      await repo.plagiarismChecks.create({
        submission_id: submission.submission_id,
        status: highRiskMatches.length > 0 ? "flagged" : "clean",
        highest_similarity: highestSimilarity,
        comparison_count: comparisonCount,
        matches: matches,
      });

      if (highRiskMatches.length > 0) {
        console.warn(
          `[AIML Plagiarism] Flagged coding submission ${submission.submission_id} for plagiarism. High-risk matches:`,
          highRiskMatches.length
        );
      } else {
        console.log(
          `[AIML Plagiarism] Submission ${submission.submission_id} passed plagiarism check with highest similarity ${highestSimilarity}%.`
        );
      }
    }
  } catch (err) {
    console.warn("[AIML Plagiarism Check] Skipped or failed:", err.message);
  }

  // ---------------------------------------------------------
  // 12. Persist individual test-case results
  // ---------------------------------------------------------

  if (testResults.length) {
    await repo.submissionTestResults.createMany(
      testResults.map((result) => ({
        submission_id:
          submission.submission_id,
        test_case_id:
          result.testCaseId,
        status: result.status,
        actual_output:
          result.actualOutput,
        expected_output:
          result.expectedOutput,
        execution_time_ms:
          result.executionTimeMs,
        error_message:
          result.errorMessage,
      }))
    );
  }

  // ---------------------------------------------------------
  // 13. Return evaluation result
  //
  // Do NOT expose hidden test-case details.
  // ---------------------------------------------------------

  return {
    status: "success",

    submission: {
      submissionId:
        submission.submission_id,

      questionId:
        numericQuestionId,

      language:
        canonicalLanguage,

      status:
        submissionStatus,

      score,

      totalMarks,

      passedTestCases,

      totalTestCases,

      executionTimeMs,

      submittedAt:
        submission.submitted_at,
    },

    testResults: testResults.map(
      (result) => {
        const testCase =
          testCases.find(
            (item) =>
              item.test_case_id ===
              result.testCaseId
          );

        return {
          testCaseId:
            result.testCaseId,

          status:
            result.status,

          // Only expose test data for visible cases.
          ...(testCase && !testCase.is_hidden
            ? {
                inputData:
                  testCase.input_data,
                expectedOutput:
                  result.expectedOutput,
                actualOutput:
                  result.actualOutput,
              }
            : {}),

          executionTimeMs:
            result.executionTimeMs,

          errorMessage:
            result.errorMessage,
        };
      }
    ),
  };
}

async function completeAssessment({ userId, sessionId }) {
  if (!userId || !sessionId) {
    const error = new Error("userId and sessionId are required");
    error.status = 400;
    throw error;
  }

  const numericSessionId = Number(sessionId);

  if (!Number.isInteger(numericSessionId)) {
    const error = new Error("Invalid sessionId");
    error.status = 400;
    throw error;
  }

  // ---------------------------------------------------------
  // 1. Find coding session
  // ---------------------------------------------------------

  const codingSession =
    await repo.codingSessions.findBySessionAndUser(
      numericSessionId,
      userId
    );

  if (!codingSession) {
    const error = new Error("Coding session not found");
    error.status = 404;
    throw error;
  }

  // ---------------------------------------------------------
  // 2. Do not allow completion twice
  // ---------------------------------------------------------

  if (codingSession.status === "Completed") {
    const completedQuizSession =
      await repo.quizSessions.findCompletedByUserAndAssessmentType(
        userId,
        "INITIAL"
      );

    if (!completedQuizSession) {
      const error = new Error(
        "Completed Initial Quiz session not found"
      );
      error.status = 409;
      throw error;
    }

    const quizScore =
      await repo.studentSkillResults.getQuizScoreBySessionId(
        completedQuizSession.session_id
      );

    const totalScore = Number(
      codingSession.total_score || 0
    );

    const maxScore = Number(
      codingSession.max_score || 300
    );

    const codingScore =
      maxScore > 0
        ? (totalScore / maxScore) * 100
        : 0;

    const readinessScore =
      calculateInitialReadiness(
        quizScore ?? 0,
        codingScore
      );

    await repo.gapReports.upsert(userId, {
      readiness_score: readinessScore,
      initial_readiness_score: readinessScore,
    });

    return {
      status: "success",
      message: "Coding assessment already completed",
      session: {
        sessionId: codingSession.session_id,
        userId: codingSession.user_id,
        status: codingSession.status,
        totalScore,
        maxScore,
        questionsCompleted:
          codingSession.questions_completed || 0,
        completedAt: codingSession.completed_at,
        remainingSeconds:
          codingSession.remaining_seconds || 0,
      },
      readiness: {
        quizScore: Number(quizScore.toFixed(2)),
        codingScore: Number(codingScore.toFixed(2)),
        readinessScore,
      },
    };
  }

  // ---------------------------------------------------------
  // 3. Prevent completion of an invalid session
  // ---------------------------------------------------------

  if (
    codingSession.status !== "In Progress" &&
    codingSession.status !== "Timed Out"
  ) {
    const error = new Error(
      `Coding assessment cannot be completed from status '${codingSession.status}'`
    );
    error.status = 409;
    throw error;
  }

  // ---------------------------------------------------------
  // 4. Determine whether the coding timer has expired
  // ---------------------------------------------------------

  const now = new Date();

  const remainingSeconds = codingSession.deadline_at
    ? Math.max(
        0,
        Math.floor(
          (new Date(codingSession.deadline_at).getTime() -
            now.getTime()) /
            1000
        )
      )
    : 0;

  const timedOut = remainingSeconds <= 0;

  // ---------------------------------------------------------
  // 5. Get all submissions for this coding session
  // ---------------------------------------------------------

  const [submissions, completedQuizSession] = await Promise.all([
    repo.codingSubmissions.findBySessionId(
      numericSessionId
    ),
    repo.quizSessions.findCompletedByUserAndAssessmentType(
      userId,
      "INITIAL"
    ),
  ]);

  // ---------------------------------------------------------
  // 6. Determine the best submission for each question
  //
  // A student may submit a question multiple times.
  // We must NEVER sum every submission.
  //
  // Example:
  //
  // Q1 -> 40
  // Q1 -> 70
  // Q1 -> 90
  //
  // Final score for Q1 = 90
  // NOT 200.
  // ---------------------------------------------------------

  const bestSubmissionByQuestion = new Map();

  for (const submission of submissions) {
    const questionId = submission.question_id;

    const currentBest =
      bestSubmissionByQuestion.get(questionId);

    const submissionScore = Number(
      submission.score || 0
    );

    const currentBestScore = currentBest
      ? Number(currentBest.score || 0)
      : -1;

    if (
      !currentBest ||
      submissionScore > currentBestScore
    ) {
      bestSubmissionByQuestion.set(
        questionId,
        submission
      );
    }
  }

  // ---------------------------------------------------------
  // 7. Determine how many questions were actually completed
  // ---------------------------------------------------------

  const questionsCompleted =
    bestSubmissionByQuestion.size;

  if (
    !timedOut &&
    questionsCompleted < CODING_QUESTION_COUNT
  ) {
    const error = new Error(
      `Please submit all ${CODING_QUESTION_COUNT} coding questions before completing the assessment`
    );
    error.status = 409;
    throw error;
  }

  // ---------------------------------------------------------
  // 8. Calculate total coding score
  // ---------------------------------------------------------

  let totalScore = 0;
  let maxScore = 0;

  for (const submission of bestSubmissionByQuestion.values()) {
    totalScore += Number(submission.score || 0);
    maxScore += Number(
      submission.total_marks || 100
    );
  }

  // The coding assessment is currently designed for
  // CODING_QUESTION_COUNT questions.
  //
  // If some questions were never submitted, their marks
  // still belong to the assessment maximum.

  const expectedMaxScore =
    CODING_QUESTION_COUNT * 100;

  if (maxScore === 0) {
    maxScore = expectedMaxScore;
  } else {
    maxScore = Math.max(
      maxScore,
      expectedMaxScore
    );
  }

  // ---------------------------------------------------------
  // 9. Determine final status
  // ---------------------------------------------------------

  const finalStatus =
  timedOut || questionsCompleted === CODING_QUESTION_COUNT
    ? "Completed"
    : "In Progress";

  // ---------------------------------------------------------
  // 10. Persist final coding session state
  // ---------------------------------------------------------

  const completedAt = now;

  const updatedSession =
    await repo.codingSessions.update(
      numericSessionId,
      {
        status: finalStatus,
        total_score: totalScore,
        max_score: maxScore,
        questions_completed: questionsCompleted,
        completed_at: completedAt,
        remaining_seconds: timedOut
          ? 0
          : remainingSeconds,
      }
    );

  // ---------------------------------------------------------
  // 11. Calculate final Initial Assessment readiness
  // ---------------------------------------------------------

  // Get the student's completed Initial Quiz session.
  // This is separate from the coding session.
  if (!completedQuizSession) {
    const error = new Error(
      "Completed Initial Quiz session not found"
    );
    error.status = 409;
    throw error;
  }

  const quizScore =
    await repo.studentSkillResults.getQuizScoreBySessionId(
      completedQuizSession.session_id
    );

  const codingScore =
    maxScore > 0
      ? (totalScore / maxScore) * 100
      : 0;

  let readinessScore = null;

  if (
    finalStatus === "Completed" &&
    questionsCompleted === CODING_QUESTION_COUNT
  ) {
    readinessScore = calculateInitialReadiness(
      quizScore ?? 0,
      codingScore
    );

    void skillGapService.generateGapReport(userId, {
      readinessScore,
    }).catch((error) => {
      console.error(
        "Background gap report generation failed:",
        error
      );
    });
  }

  // ---------------------------------------------------------
  // 12. Return final coding assessment result
  // ---------------------------------------------------------

  return {
    status: "success",

    message: timedOut
      ? "Coding assessment time expired and the assessment has been submitted"
      : "Coding assessment completed successfully",

    session: {
      sessionId: updatedSession.session_id,
      userId: updatedSession.user_id,
      status: updatedSession.status,
      totalScore: Number(
        updatedSession.total_score || 0
      ),
      maxScore: Number(
        updatedSession.max_score || maxScore
      ),
      questionsCompleted:
        updatedSession.questions_completed || 0,
      startedAt: updatedSession.started_at,
      completedAt: updatedSession.completed_at,
      deadlineAt: updatedSession.deadline_at,
      remainingSeconds:
        updatedSession.remaining_seconds || 0,
    },

    result: {
      totalScore,
      maxScore,
      questionsCompleted,
      questionsTotal: CODING_QUESTION_COUNT,
      percentage:
        maxScore > 0
          ? Number(
              ((totalScore / maxScore) * 100).toFixed(2)
            )
          : 0,
    },

    readiness: {
      quizScore: Number(quizScore.toFixed(2)),
      codingScore: Number(codingScore.toFixed(2)),
      readinessScore,
    },
  };
}

async function activateAssessment({ userId, sessionId }) {
  const codingSession =
    await repo.codingSessions.findBySessionAndUser(
      Number(sessionId),
      userId
    );

  if (!codingSession) {
    const error = new Error("Coding session not found");
    error.status = 404;
    throw error;
  }

  if (codingSession.status === "Completed") {
    const error = new Error(
      "Coding assessment has already been completed"
    );
    error.status = 409;
    throw error;
  }

  if (codingSession.status === "Timed Out") {
    const error = new Error(
      "Coding assessment time has expired"
    );
    error.status = 409;
    throw error;
  }

  if (codingSession.status === "In Progress") {
    const remainingSeconds = Math.max(
      0,
      Math.floor(
        (new Date(codingSession.deadline_at).getTime() -
          Date.now()) / 1000
      )
    );

    return {
      activated: true,
      remaining_seconds: remainingSeconds,
      deadline_at: codingSession.deadline_at,
    };
  }

  const remainingSeconds = Number(
    codingSession.remaining_seconds || 0
  );

  if (remainingSeconds <= 0) {
    await repo.codingSessions.update(Number(sessionId), {
      status: "Timed Out",
      remaining_seconds: 0,
      completed_at: new Date(),
      deadline_at: null,
    });

    const error = new Error(
      "Coding assessment time has expired"
    );
    error.status = 409;
    throw error;
  }

  const deadlineAt = new Date(
    Date.now() + remainingSeconds * 1000
  );

  await repo.codingSessions.update(Number(sessionId), {
    status: "In Progress",
    deadline_at: deadlineAt,
  });

  return {
    activated: true,
    remaining_seconds: remainingSeconds,
    deadline_at: deadlineAt,
  };
}

async function pauseAssessment({ userId, sessionId }) {
  const codingSession =
    await repo.codingSessions.findBySessionAndUser(
      Number(sessionId),
      userId
    );

  if (!codingSession) {
    const error = new Error("Coding session not found");
    error.status = 404;
    throw error;
  }

  if (codingSession.status === "Paused") {
    return {
      paused: true,
      remaining_seconds: Number(
        codingSession.remaining_seconds || 0
      ),
    };
  }

  if (codingSession.status !== "In Progress") {
    const error = new Error(
      "Coding assessment cannot be paused in its current state"
    );
    error.status = 409;
    throw error;
  }

  const remainingSeconds = codingSession.deadline_at
    ? Math.max(
        0,
        Math.floor(
          (new Date(codingSession.deadline_at).getTime() -
            Date.now()) / 1000
        )
      )
    : 0;

  if (remainingSeconds <= 0) {
    await repo.codingSessions.update(Number(sessionId), {
      status: "Timed Out",
      remaining_seconds: 0,
      completed_at: new Date(),
      deadline_at: null,
    });

    const error = new Error(
      "Coding assessment time has expired"
    );
    error.status = 409;
    throw error;
  }

  await repo.codingSessions.update(Number(sessionId), {
    status: "Paused",
    remaining_seconds: remainingSeconds,
    deadline_at: null,
  });

  return {
    paused: true,
    remaining_seconds: remainingSeconds,
  };
}

async function heartbeatAssessment({ userId, sessionId }) {
  const codingSession =
    await repo.codingSessions.findBySessionAndUser(
      Number(sessionId),
      userId
    );

  if (!codingSession) {
    const error = new Error("Coding session not found");
    error.status = 404;
    throw error;
  }

  if (codingSession.status !== "In Progress") {
    return {
      active: false,
      status: codingSession.status,
      remaining_seconds: Number(
        codingSession.remaining_seconds || 0
      ),
    };
  }

  const remainingSeconds = Math.max(
    0,
    Math.floor(
      (new Date(codingSession.deadline_at).getTime() -
        Date.now()) / 1000
    )
  );

  if (remainingSeconds <= 0) {
    await repo.codingSessions.update(Number(sessionId), {
      status: "Timed Out",
      remaining_seconds: 0,
      completed_at: new Date(),
      deadline_at: null,
    });

    return {
      active: false,
      status: "Timed Out",
      remaining_seconds: 0,
    };
  }

  await repo.codingSessions.update(Number(sessionId), {
    remaining_seconds: remainingSeconds,
  });

  return {
    active: true,
    status: "In Progress",
    remaining_seconds: remainingSeconds,
    deadline_at: codingSession.deadline_at,
  };
}

module.exports = {
  startAssessment,
  activateAssessment,
  pauseAssessment,
  heartbeatAssessment,
  runStudentCode,
  submitCode,
  completeAssessment,
  executeTestCases,
  CODING_QUESTION_COUNT,
};