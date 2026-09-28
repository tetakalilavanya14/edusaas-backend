const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
]);

const SOURCE_EXTENSIONS = {
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".java": "Java",
  ".c": "C",
  ".h": "C/C++",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
  ".php": "PHP",
  ".rb": "Ruby",
  ".swift": "Swift",
  ".kt": "Kotlin",
};

const PROJECT_MARKERS = {
  "package.json": "Node.js",
  "requirements.txt": "Python",
  "pyproject.toml": "Python",
  "Pipfile": "Python",
  "pom.xml": "Java",
  "build.gradle": "Java",
  "build.gradle.kts": "Java",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
  "composer.json": "PHP",
  "Gemfile": "Ruby",
  "*.csproj": "C#",
  "CMakeLists.txt": "C/C++",
};

const SEMGREP_CONFIG = path.join(
  __dirname,
  "static-analysis",
  "rules",
  "vayvora.yml"
);

const SEMGREP_TIMEOUT_MS =
  Number(process.env.SEMGREP_TIMEOUT_MS) || 120 * 1000;
const MAX_ANALYSIS_FILES =
  Number(process.env.MAX_ANALYSIS_FILES) || 5000;

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function readDirectorySafe(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkRepository(directory, relativePath = "", state = { count: 0 }) {
  const currentDirectory = path.join(directory, relativePath);
  const entries = await readDirectorySafe(currentDirectory);
  const files = [];

  for (const entry of entries) {
    const entryRelativePath = path.join(relativePath, entry.name);

    if (
      entry.isDirectory() &&
      IGNORED_DIRECTORIES.has(entry.name)
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      const nestedFiles = await walkRepository(
        directory,
        entryRelativePath,
        state
      );

      files.push(...nestedFiles);
      continue;
    }

    if (entry.isFile()) {
      state.count += 1;
      if (state.count > MAX_ANALYSIS_FILES) {
        throw new Error(
          `Repository exceeds the maximum allowed file limit (${MAX_ANALYSIS_FILES} files).`
        );
      }
      files.push(entryRelativePath);
    }
  }

  return files;
}

function detectLanguages(files) {
  const counts = new Map();

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    const language = SOURCE_EXTENSIONS[extension];

    if (!language) continue;

    counts.set(language, (counts.get(language) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, fileCount]) => ({
      language,
      fileCount,
    }));
}

async function detectProjectTypes(directory, files) {
  const detectedTypes = new Set();

  for (const file of files) {
    const normalizedFile = normalizePath(file);
    const fileName = path.basename(normalizedFile);

    for (const marker of Object.keys(PROJECT_MARKERS)) {
      if (marker.startsWith("*")) {
        const extension = marker.slice(1).toLowerCase();

        if (
          path.extname(fileName).toLowerCase() === extension
        ) {
          detectedTypes.add(PROJECT_MARKERS[marker]);
        }

        continue;
      }

      if (fileName === marker) {
        detectedTypes.add(PROJECT_MARKERS[marker]);
      }
    }
  }

  const packageJsonFiles = files.filter(
    (file) => path.basename(file) === "package.json"
  );

  for (const relativePackagePath of packageJsonFiles) {
    const packageJsonPath = path.join(
      directory,
      relativePackagePath
    );

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf8")
      );

      detectedTypes.add("Node.js");

      const dependencies = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      if (
        dependencies.react ||
        dependencies["react-dom"]
      ) {
        detectedTypes.add("React");
      }

      if (dependencies.express) {
        detectedTypes.add("Express.js");
      }

      if (dependencies.next) {
        detectedTypes.add("Next.js");
      }

      if (dependencies["@nestjs/core"]) {
        detectedTypes.add("NestJS");
      }
    } catch {
      // Ignore malformed package.json files.
    }
  }

  return [...detectedTypes];
}

function determineProjectType(projectTypes, files) {
  const normalizedFiles = files.map(normalizePath);

  const hasFrontendDirectory = normalizedFiles.some(
    (file) => file.split("/")[0].toLowerCase() === "frontend"
  );

  const hasBackendDirectory = normalizedFiles.some(
    (file) => file.split("/")[0].toLowerCase() === "backend"
  );

  if (hasFrontendDirectory && hasBackendDirectory) {
    return "Full Stack Web Application";
  }

  if (
    projectTypes.includes("React") ||
    projectTypes.includes("Next.js")
  ) {
    return "Frontend Web Application";
  }

  if (
    projectTypes.includes("Express.js") ||
    projectTypes.includes("Node.js")
  ) {
    return "Backend Web Application";
  }

  if (projectTypes.includes("Python")) {
    return "Python Application";
  }

  if (projectTypes.includes("Java")) {
    return "Java Application";
  }

  if (projectTypes.length > 0) {
    return projectTypes[0];
  }

  return "Unknown";
}

function normalizeSeverity(severity) {
  const value = String(severity || "").toUpperCase();

  if (value === "ERROR") return "HIGH";
  if (value === "WARNING") return "MEDIUM";

  return "LOW";
}

function normalizeSemgrepResults(results) {
  return (results.results || []).map((result) => ({
    severity: normalizeSeverity(result.extra?.severity),
    category: result.extra?.metadata?.category || "Security",
    rule: result.check_id.split(".").pop(),
    file: normalizePath(result.path),
    line: result.start?.line || null,
    message:
      result.extra?.message ||
      "Static analysis finding detected.",
  }));
}

async function runSemgrep(directory) {
  const args = [
    "--config",
    SEMGREP_CONFIG,
    "--json",
    "--no-git-ignore",
    directory,
  ];

  try {
    const { stdout } = await execFileAsync(
      "semgrep",
      args,
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: SEMGREP_TIMEOUT_MS,
        windowsHide: true,
      }
    );

    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "Semgrep is not installed or not found in PATH. Please install Semgrep on the host running the worker."
      );
    }

    if (error.code === "ETIMEDOUT" || error.killed) {
      throw new Error(
        `Semgrep analysis timed out after ${SEMGREP_TIMEOUT_MS / 1000} seconds.`
      );
    }

    const message =
      error?.stderr?.trim() ||
      error?.stdout?.trim() ||
      error?.message ||
      "Semgrep execution failed.";

    throw new Error(`Semgrep execution failed: ${message}`);
  }
}

function summarizeFindings(findings) {
  const summary = {
    total: findings.length,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const finding of findings) {
    if (finding.severity === "HIGH") {
      summary.high += 1;
    } else if (finding.severity === "MEDIUM") {
      summary.medium += 1;
    } else if (finding.severity === "LOW") {
      summary.low += 1;
    }
  }

  return summary;
}

async function analyzeRepository(directory) {
  if (!directory) {
    throw new Error("Repository directory is required.");
  }

  const files = await walkRepository(directory);

  const languages = detectLanguages(files);

  const projectTypes = await detectProjectTypes(
    directory,
    files
  );

  const projectType = determineProjectType(
    projectTypes,
    files
  );

  const sourceFiles = files.filter((file) => {
    const extension = path.extname(file).toLowerCase();

    return Boolean(SOURCE_EXTENSIONS[extension]);
  });

  const semgrepResult = await runSemgrep(directory);

  const findings = normalizeSemgrepResults(
    semgrepResult
  ).map((finding) => ({
    ...finding,
    file: path.isAbsolute(finding.file)
      ? path.relative(directory, finding.file).replace(/\\/g, "/")
      : finding.file,
  }));

  return {
    projectType,
    projectTypes,
    languages,
    totalFiles: files.length,
    sourceFiles,
    findings,
    findingSummary: summarizeFindings(findings),
  };
}

module.exports = {
  analyzeRepository,
  walkRepository,
  detectLanguages,
  detectProjectTypes,
  determineProjectType,
  summarizeFindings,
};