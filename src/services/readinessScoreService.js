const clampScore = (score) =>
  Math.min(100, Math.max(0, Number(score) || 0));

const calculateInitialReadiness = (
  initialQuizScore,
  initialCodingScore
) => {
  const quiz = clampScore(initialQuizScore);
  const coding = clampScore(initialCodingScore);

  return Number(
    clampScore(
      quiz * 0.60 +
      coding * 0.40
    ).toFixed(2)
  );
};

/**
 * Calculate static-analysis quality score.
 *
 * HIGH   = -10
 * MEDIUM = -4
 * LOW    = -1
 */
const calculateStaticScore = (findingSummary = {}) => {
  const high = Number(findingSummary.high || 0);
  const medium = Number(findingSummary.medium || 0);
  const low = Number(findingSummary.low || 0);

  const deductions =
    high * 10 +
    medium * 4 +
    low * 1;

  return Number(clampScore(100 - deductions).toFixed(2));
};

/**
 * Convert plagiarism similarity into a penalty.
 */
const calculatePlagiarismPenalty = (similarity = 0) => {
  const value = clampScore(similarity);

  if (value < 20) return 0;
  if (value < 40) return 0.10;
  if (value < 60) return 0.25;
  if (value < 80) return 0.50;

  return 1.00;
};

/**
 * Calculate the final mini-project score.
 *
 * Static quality is the base score.
 * Plagiarism reduces that score.
 */
const calculateMiniProjectScore = (
  staticScore,
  plagiarismSimilarity = 0
) => {
  const qualityScore = clampScore(staticScore);

  const plagiarismPenalty =
    calculatePlagiarismPenalty(plagiarismSimilarity);

  const finalScore =
    qualityScore * (1 - plagiarismPenalty);

  return Number(clampScore(finalScore).toFixed(2));
};

/**
 * Final readiness:
 *
 * Final Quiz      = 40%
 * Mini Project    = 60%
 */
const calculateFinalReadiness = (
  finalQuizScore,
  miniProjectScore
) => {
  const quiz = clampScore(finalQuizScore);
  const project = clampScore(miniProjectScore);

  return Number(
    clampScore(
      quiz * 0.40 +
      project * 0.60
    ).toFixed(2)
  );
};

/**
 * Effective readiness is the best demonstrated readiness.
 */
const calculateEffectiveReadiness = (
  initialScore,
  finalScore
) => {
  const initial =
    initialScore == null
      ? null
      : clampScore(initialScore);

  const final =
    finalScore == null
      ? null
      : clampScore(finalScore);

  if (initial == null && final == null) {
    return 0;
  }

  if (initial == null) {
    return Number(final.toFixed(2));
  }

  if (final == null) {
    return Number(initial.toFixed(2));
  }

  return Number(
    Math.max(initial, final).toFixed(2)
  );
};

module.exports = {
  calculateInitialReadiness,
  calculateStaticScore,
  calculatePlagiarismPenalty,
  calculateMiniProjectScore,
  calculateFinalReadiness,
  calculateEffectiveReadiness,
};