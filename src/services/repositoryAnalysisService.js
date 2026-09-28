const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

const SUPPORTED_SOURCE_EXTENSIONS = {
  ".py": "python",
  ".js": "javascript",
  ".java": "java",
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  "out",
]);

const IGNORED_FILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pipfile.lock",
]);

const MAX_SOURCE_FILE_SIZE = 1024 * 1024; // 1 MB

function createRepositoryError(message, status = 400, code = "REPOSITORY_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function runGit(args, options = {}) {
  const {
    cwd,
    timeout = DEFAULT_TIMEOUT_MS,
  } = options;

  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const message =
      error?.stderr?.trim() ||
      error?.stdout?.trim() ||
      error?.message ||
      "Git command failed.";

    if (error?.code === "ETIMEDOUT") {
      throw createRepositoryError(
        "Repository operation timed out.",
        504,
        "GIT_TIMEOUT"
      );
    }

    throw createRepositoryError(
      `Git operation failed: ${message}`,
      502,
      "GIT_COMMAND_FAILED"
    );
  }
}

async function createTemporaryDirectory() {
  const baseDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vayvora-mini-project-")
  );

  return baseDirectory;
}

async function removeTemporaryDirectory(directory) {
  if (!directory) return;

  try {
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.error(
      "[repositoryAnalysis] Failed to remove temporary directory:",
      directory,
      error.message
    );
  }
}

/**
 * Fetch the exact commit submitted by the student.
 *
 * IMPORTANT:
 * - Does not execute repository code.
 * - Does not run npm install / pip install.
 * - Does not run build/start commands.
 * - Uses a shallow fetch of the exact commit.
 *
 * Returns a temporary directory containing the checked-out repository.
 *
 * The caller is responsible for cleanup using cleanupRepository().
 */
async function fetchRepositoryAtCommit({
  repositoryUrl,
  commitSha,
}) {
  if (!repositoryUrl || typeof repositoryUrl !== "string") {
    throw createRepositoryError(
      "repositoryUrl is required."
    );
  }

  if (!commitSha || typeof commitSha !== "string") {
    throw createRepositoryError(
      "commitSha is required."
    );
  }

  const tempDirectory = await createTemporaryDirectory();

  try {
    await runGit(
      ["init"],
      {
        cwd: tempDirectory,
      }
    );

    await runGit(
      [
        "remote",
        "add",
        "origin",
        repositoryUrl,
      ],
      {
        cwd: tempDirectory,
      }
    );

    await runGit(
      [
        "fetch",
        "--depth",
        "1",
        "origin",
        commitSha,
      ],
      {
        cwd: tempDirectory,
        timeout: 120000,
      }
    );

    await runGit(
      [
        "checkout",
        "--detach",
        "FETCH_HEAD",
      ],
      {
        cwd: tempDirectory,
      }
    );

    return {
      directory: tempDirectory,
      commitSha,
    };
  } catch (error) {
    await removeTemporaryDirectory(tempDirectory);
    throw error;
  }
}

async function extractSourceFiles(repositoryDirectory) {
  if (!repositoryDirectory || typeof repositoryDirectory !== "string") {
    throw createRepositoryError(
      "repositoryDirectory is required."
    );
  }

  const sourceFiles = [];

  async function walkDirectory(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const entryName = entry.name;

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entryName)) {
          continue;
        }

        await walkDirectory(
          path.join(currentDirectory, entryName)
        );

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (IGNORED_FILE_NAMES.has(entryName)) {
        continue;
      }

      const extension = path.extname(entryName).toLowerCase();
      const language = SUPPORTED_SOURCE_EXTENSIONS[extension];

      if (!language) {
        continue;
      }

      const filePath = path.join(currentDirectory, entryName);

      const stats = await fs.stat(filePath);

      if (stats.size > MAX_SOURCE_FILE_SIZE) {
        console.warn(
          `[repositoryAnalysis] Skipping oversized source file: ${filePath}`
        );
        continue;
      }

      try {
        const code = await fs.readFile(filePath, "utf8");

        const relativePath = path
          .relative(repositoryDirectory, filePath)
          .split(path.sep)
          .join("/");

        sourceFiles.push({
          path: relativePath,
          language,
          code,
        });
      } catch (error) {
        console.warn(
          `[repositoryAnalysis] Failed to read source file: ${filePath}`,
          error.message
        );
      }
    }
  }

  await walkDirectory(repositoryDirectory);

  return sourceFiles;
}

async function cleanupRepository(directory) {
  await removeTemporaryDirectory(directory);
}

module.exports = {
  fetchRepositoryAtCommit,
  cleanupRepository,
  extractSourceFiles,
};