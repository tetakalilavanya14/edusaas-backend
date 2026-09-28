const GITHUB_API_BASE = "https://api.github.com";

function createGithubError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseGitHubRepositoryUrl(repositoryUrl) {
  if (typeof repositoryUrl !== "string" || !repositoryUrl.trim()) {
    throw createGithubError("repository_url is required.");
  }

  let url;

  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    throw createGithubError("repository_url must be a valid GitHub URL.");
  }

  if (url.protocol !== "https:") {
    throw createGithubError("Only HTTPS GitHub repository URLs are allowed.");
  }

  if (url.hostname.toLowerCase() !== "github.com") {
    throw createGithubError("repository_url must point to github.com.");
  }

  const parts = url.pathname
    .split("/")
    .filter(Boolean);

  if (parts.length < 2) {
    throw createGithubError(
      "repository_url must point to a GitHub repository."
    );
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");

  if (!owner || !repo) {
    throw createGithubError(
      "repository_url must contain a GitHub owner and repository."
    );
  }

  return { owner, repo };
}

async function githubRequest(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Vayvora-Edu-SaaS",
  };

  // Add GitHub Token if available to raise rate limit from 60 to 5,000 req/hr
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method: "GET",
    headers,
  });

  if (response.status === 404) {
    throw createGithubError(
      "GitHub repository or branch was not found.",
      404
    );
  }

  if (response.status === 403) {
    throw createGithubError(
      "GitHub API rate limit exceeded. Please try again later.",
      429
    );
  }

  if (!response.ok) {
    let message = "GitHub request failed.";

    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore invalid/non-JSON response
    }

    const error = createGithubError(message, 502);
    error.code = "GITHUB_API_ERROR";
    throw error;
  }

  return response.json();
}

async function validateRepository(repositoryUrl, branch) {
  const { owner, repo } = parseGitHubRepositoryUrl(repositoryUrl);

  let targetBranch = typeof branch === "string" && branch.trim() ? branch.trim() : null;

  // 1. If no branch provided, fetch repo metadata to get default branch (main/master)
  if (!targetBranch) {
    const repoData = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
    targetBranch = repoData.default_branch || "main";
  }

  // 2. Fetch target branch data (Verifies existence + gets commit SHA in 1 request)
  const branchData = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(targetBranch)}`
  );

  const commitSha = branchData?.commit?.sha;

  if (!commitSha) {
    throw createGithubError(
      "Unable to determine the latest commit for the selected branch.",
      502
    );
  }

  return {
    owner,
    repo,
    repository_url: `https://github.com/${owner}/${repo}`,
    branch: targetBranch,
    commit_sha: commitSha,
  };
}

module.exports = {
  validateRepository,
  parseGitHubRepositoryUrl,
};