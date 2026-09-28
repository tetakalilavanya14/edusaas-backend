const prismaRepo = require("../data/prismaRepo");

const {
  fetchRepositoryAtCommit,
  cleanupRepository,
  extractSourceFiles,
} = require("./repositoryAnalysisService");

const {
  analyzeRepository,
} = require("./staticAnalysisService");
const skillGapService = require("./skillGapService")

const {checkMiniProjectPlagiarism} = require("./aimlClient")
const {calculateStaticScore, calculateMiniProjectScore } = require("./readinessScoreService")

const DEFAULT_BATCH_SIZE = 5;

async function processAnalysis(analysis) {
  let repositoryDirectory = null; 
  const comparisonDirectories = []; 
  let currentStage = "static";

  try {
    /*
     * 1. Atomically claim the analysis.
     */
    const claimResult =
      await prismaRepo.miniProjects.claimAnalysis(analysis.id);

    if (claimResult.count !== 1) {
      return {
        processed: false,
        reason: "already_claimed",
      };
    }

    /*
     * 2. Fetch the exact GitHub commit submitted
     *    by the student.
     */
    const repository = await fetchRepositoryAtCommit({
      repositoryUrl: analysis.submission.repository_url,
      commitSha: analysis.submission.commit_sha,
    });

    repositoryDirectory = repository.directory;

    /*
     * 3. Run static analysis.
     */
    const result = await analyzeRepository(repositoryDirectory);
    const staticScore = calculateStaticScore( result.findingSummary)

    /*
     * 4. Persist all static-analysis findings.
     */
    await prismaRepo.miniProjects.saveStaticAnalysisFindings(
      analysis.id,
      result.findings
    );

    /*
     * 5. Mark ONLY the static-analysis stage as completed.
     *
     * Overall analysis must remain RUNNING because
     * plagiarism is the next stage.
     */
    await prismaRepo.miniProjects.completeStaticAnalysis(
      analysis.id,
      {
        languages: result.languages,
        projectType: result.projectType,
      }
    );

    /*
     * 6. Start plagiarism analysis.
     */
    await prismaRepo.miniProjects.startPlagiarismAnalysis(
      analysis.id
    );

    currentStage = "plagiarism";

    /*
     * 7. Extract source files from the current submission.
     *
     * The same cloned repository is reused. We do not
     * clone the student's repository a second time.
     */
    const submissionFiles =
      await extractSourceFiles(repositoryDirectory);

    /*
     * 8. Find other submitted projects belonging to
     *    the same assignment.
     */
    const comparisonSubmissions =
      await prismaRepo.miniProjects.getComparisonSubmissions({
        assignmentId: analysis.submission.assignment_id,
        excludeSubmissionId: analysis.submission.id,
        excludeStudentId: analysis.submission.student_id,
      });

    /*
     * 9. Clone and extract every comparison submission.
     */
    const comparisonPayloads = [];

    for (const comparisonSubmission of comparisonSubmissions) {
      let comparisonDirectory = null;

      try {
        const comparisonRepository =
          await fetchRepositoryAtCommit({
            repositoryUrl: comparisonSubmission.repository_url,
            commitSha: comparisonSubmission.commit_sha,
          });

        comparisonDirectory = comparisonRepository.directory;
        comparisonDirectories.push(comparisonDirectory);

        const comparisonFiles =
          await extractSourceFiles(comparisonDirectory);

        /*
         * Ignore comparison repositories that contain
         * no supported source files.
         */
        if (!comparisonFiles.length) {
          continue;
        }

        comparisonPayloads.push({
          submission_id: comparisonSubmission.id,
          files: comparisonFiles,
        });
      } catch (comparisonError) {
        /*
         * One bad comparison repository should not prevent
         * plagiarism analysis against the remaining projects.
         */
        console.warn(
          "[miniProjectAnalysisWorker] Failed to prepare comparison submission:",
          comparisonSubmission.id,
          comparisonError.message
        );
      }
    }

    /*
     * 10. Call the AIML plagiarism service.
     *
     * Even when comparisonPayloads is empty, we still call
     * AIML. The AIML service supports comparison_count = 0.
     */
    const plagiarismResult =
      await checkMiniProjectPlagiarism({
        submission: {
          submission_id: analysis.submission.id,
          files: submissionFiles,
        },
        comparisonSubmissions: comparisonPayloads,
      });

      const miniProjectScore = calculateMiniProjectScore(
        staticScore,
        plagiarismResult.overall_similarity ?? 0
      );

      await prismaRepo.miniProjects.updateMiniProjectReadinessScore(
        analysis.id,
        miniProjectScore
      );

    /*
     * 11. Persist plagiarism result and all project matches.
     */
    await prismaRepo.miniProjects.saveMiniProjectPlagiarismResult(
      analysis.id,
      {
        status: plagiarismResult.status,
        highestSimilarity:
          plagiarismResult.overall_similarity ?? null,
        comparisonCount:
          plagiarismResult.comparison_count ?? 0,
        matches: plagiarismResult.matches || [],
      }
    );

    

    

    /*
     * 12. Plagiarism is the final analysis stage for now.
     *     Mark both plagiarism and overall analysis completed.
     */
    await prismaRepo.miniProjects.completePlagiarismAnalysis(
      analysis.id
    );

    await skillGapService.updateFinalReadiness(
      analysis.submission.student_id,
      null,
      miniProjectScore
    );

    return {
      processed: true,
      analysisId: analysis.id,
      findingCount: result.findings.length,
      staticScore,
      miniProjectScore,
      comparisonCount:
        plagiarismResult.comparison_count ?? 0,
      overallSimilarity:
        plagiarismResult.overall_similarity ?? 0,
    };
  } catch (error) {
      try {
        if (currentStage === "plagiarism") {
          await prismaRepo.miniProjects.failPlagiarismAnalysis(
            analysis.id,
            error.message || "Plagiarism analysis failed."
          );
        } else {
          await prismaRepo.miniProjects.failStaticAnalysis(
            analysis.id,
            error.message || "Static analysis failed."
          );
        }
      } catch (updateError) {
        console.error(
          "[miniProjectAnalysisWorker] Failed to mark analysis as FAILED:",
          updateError.message
        );
      }

      console.error(
        "[miniProjectAnalysisWorker] Analysis failed:",
        analysis.id,
        error
      );

      return {
        processed: false,
        analysisId: analysis.id,
        reason: "failed",
        error: error.message,
      };
    } finally {
    /*
     * Always clean up the student's temporary repository.
     */
    if (repositoryDirectory) {
      await cleanupRepository(repositoryDirectory);
    }

    /*
     * Always clean up all comparison repositories.
     */
    for (const directory of comparisonDirectories) {
      await cleanupRepository(directory);
    }
  }
}

async function processQueuedAnalyses(
  batchSize = DEFAULT_BATCH_SIZE
) {
  const analyses =
    await prismaRepo.miniProjects.getQueuedAnalyses(batchSize);

  if (!analyses.length) {
    return {
      found: 0,
      processed: 0,
      failed: 0,
    };
  }

  let processed = 0;
  let failed = 0;

  for (const analysis of analyses) {
    const result = await processAnalysis(analysis);

    if (result.processed) {
      processed += 1;
    } else if (result.reason === "failed") {
      failed += 1;
    }
  }

  return {
    found: analyses.length,
    processed,
    failed,
  };
}

async function recoverStuckAnalyses(timeoutMinutes = 15) {
  try {
    const result =
      await prismaRepo.miniProjects.recoverStuckAnalyses(timeoutMinutes);

    if (result && result.count > 0) {
      console.warn(
        `[miniProjectAnalysisWorker] Recovered ${result.count} stuck analysis record(s) older than ${timeoutMinutes} minutes.`
      );
    }

    return result;
  } catch (error) {
    console.error(
      "[miniProjectAnalysisWorker] Failed to recover stuck analyses:",
      error.message
    );
  }
}

module.exports = {
  processAnalysis,
  processQueuedAnalyses,
  recoverStuckAnalyses,
};