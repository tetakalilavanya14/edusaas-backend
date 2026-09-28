const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Increased process timeout to give Docker container boot & compilation buffer room
const CONTAINER_MAX_TIMEOUT = 30000;

const DOCKER_IMAGES = {
    python: process.env.CODING_DOCKER_PYTHON_IMAGE || "shivateja1234/edusaas-python:latest",
    cpp: process.env.CODING_DOCKER_CPP_IMAGE || "shivateja1234/edusaas-cpp:latest",
    c: process.env.CODING_DOCKER_C_IMAGE || "shivateja1234/edusaas-c:latest",
    java: process.env.CODING_DOCKER_JAVA_IMAGE || "shivateja1234/edusaas-java:latest",
    javascript: process.env.CODING_DOCKER_JAVASCRIPT_IMAGE || "shivateja1234/edusaas-javascript:latest"
};

/**
 * Returns language configuration for container execution
 */
function getLanguageConfig(language) {
    const lang = language.trim().toLowerCase();

    switch (lang) {
        case "python":
        case "py":
            return {
                image: DOCKER_IMAGES.python,
                filename: "main.py",
                command: "python3 main.py < input.txt"
            };

        case "cpp":
        case "c++":
            return {
                image: DOCKER_IMAGES.cpp,
                filename: "main.cpp",
                command: "g++ main.cpp -o /tmp/main && /tmp/main < input.txt"
            };

        case "c":
             return {
                image: DOCKER_IMAGES.c,
                filename: "main.c",
                command: "gcc main.c -O2 -o /tmp/main && /tmp/main < input.txt"
            };

        case "java":
            return {
                image: DOCKER_IMAGES.java,
                filename: "Main.java",
                // Added fast JVM startup parameters (-XX:+UseSerialGC -Xms16m -Xmx128m)
                command: "javac -d /tmp Main.java && java -XX:+UseSerialGC -Xms16m -Xmx128m -cp /tmp Main < input.txt"
            };
        case "javascript":
        case "js":
            return {
                image: DOCKER_IMAGES.javascript,
                filename: "main.js",
                command: "node main.js < input.txt"
            };

        default:
            return null;
    }
}

async function runCode(language, code, input = "") {
    const config = getLanguageConfig(language);
    if (!config) {
       throw new Error(
            `Unsupported language: '${language}'. Supported languages are Python, C, C++, Java, and JavaScript.`
        );
    }

    const executionId = crypto.randomUUID();
    const containerName = `edusaas-${executionId}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "edusaas-"));

    const codeFile = path.join(tempDir, config.filename);
    const inputFile = path.join(tempDir, "input.txt");

    fs.writeFileSync(codeFile, code, "utf8");
    fs.writeFileSync(inputFile, input || "", "utf8");

    const dockerArgs = [
        "run",
        "--rm",
        "--name", containerName,
        "--network", "none",
        "--memory", "256m",
        "--cpus", "1.5", // Increased from 0.5 to 1.5 to eliminate compilation bottlenecks
        "--pids-limit", "64",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "-v", `${path.resolve(tempDir)}:/workspace:ro`,
        "-w", "/workspace",
        config.image,
        "sh", "-c", config.command
    ];

    const startTime = Date.now();

    return new Promise((resolve) => {
        let finished = false;

        execFile("docker", dockerArgs, { timeout: CONTAINER_MAX_TIMEOUT }, (error, stdout, stderr) => {
            if (finished) return;
            finished = true;

            const executionTime = Date.now() - startTime;
            const cleanStdout = (stdout || "").trim();
            const cleanStderr = (stderr || "").trim();

            if (error && (error.code === "ETIMEDOUT" || error.killed)) {
                // Force kill container on execution timeout
                spawn(
                    "docker",
                    ["rm", "-f", containerName],
                    { windowsHide: true }
                );

                return resolve({
                    status: "timeout",
                    stdout: cleanStdout,
                    stderr: "Time Limit Exceeded",
                    exitCode: null,
                    executionTime: CONTAINER_MAX_TIMEOUT
                });
            }

            if (error) {
                return resolve({
                    status: "runtime_error",
                    stdout: cleanStdout,
                    stderr: cleanStderr || error.message,
                    exitCode: error.code || 1,
                    executionTime
                });
            }

            return resolve({
                status: "success",
                stdout: cleanStdout,
                stderr: cleanStderr,
                exitCode: 0,
                executionTime
            });
        });
    }).finally(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (err) {
            console.error("Cleanup error:", err.message);
        }
    });
}

async function runCodeBatch(language, code, inputs = [], concurrency = 4) {
    const results = [];
    const batchSize = Math.max(1, Number(concurrency) || 1);

    for (let start = 0; start < inputs.length; start += batchSize) {
        const batch = inputs.slice(start, start + batchSize);
        const batchResults = await Promise.all(
            batch.map((input) => runCode(language, code, input))
        );

        results.push(...batchResults);
    }

    return results;
}

module.exports = { runCode, runCodeBatch };