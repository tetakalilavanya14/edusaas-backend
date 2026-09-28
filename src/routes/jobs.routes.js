const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const repo = require("../data");
const { sendEmail } = require("../config/mail");
const { authRequired, permissionRequired } = require("../middleware/auth");
const aimlClient = require("../services/aimlClient");





const router = express.Router();

// --------------------------------------------------
// Resume Upload Configuration
// --------------------------------------------------
const uploadResume = require("../middleware/uploadResume");
const uploadApplication = require("../middleware/uploadApplication");

const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const b2Client = require("../../services/b2Storage");

// --------------------------------------------------
// Video Upload Configuration
// --------------------------------------------------
const uploadApplicationFiles = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 100 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (file.fieldname === "video") {
      const isVideo =
        file.mimetype?.startsWith("video/") ||
        /\.(webm|mp4|mov|avi|mkv)$/i.test(file.originalname);

      if (!isVideo) {
        return cb(
          new Error("Only video files are allowed for video upload.")
        );
      }

      return cb(null, true);
    }

    if (file.fieldname === "resume") {
      const allowedExtensions = [".pdf", ".doc", ".docx"];
      const extension = path.extname(file.originalname).toLowerCase();

      if (!allowedExtensions.includes(extension)) {
        return cb(
          new Error("Only PDF, DOC, and DOCX resumes are allowed.")
        );
      }

      return cb(null, true);
    }

    cb(null, true);
  },
});

 {/*helper function for close the jobs when expires */}
const isJobExpired = (job) => {
  return (
    job.application_deadline &&
    new Date(job.application_deadline) < new Date()
  );
};


/**
 * @openapi
 * /api/jobs:
 *   get:
 *     tags: [Jobs]
 *     summary: List job postings
 *     parameters:
 *       - in: query
 *         name: employer_id
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of jobs
 *   post:
 *     tags: [Jobs]
 *     summary: Create job posting (Employer/Admin)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               requirements:
 *                 type: string
 *               required_skills:
 *
 *                 type: array
 *                 items:
 *                   type: string
 *               status:
 *                 type: string
 *                 example: open
 *     responses:
 *       201:
 *         description: Job created
 */

router.get("/", async (req, res, next) => {
  try {
     console.log("FILES RECEIVED:", req.files);

    const jobs = req.query.employer_id
      ? await repo.jobs.listByEmployer(req.query.employer_id)
      : await repo.jobs.list();

    for (const job of jobs) {
      if (
        job.status === "open" &&
        job.application_deadline &&
        new Date(job.application_deadline) < new Date()
      ) {
        await repo.jobs.update(job.id, {
          status: "closed",
        });

        job.status = "closed";
      }
    }

    return res.json(jobs);

  } catch (err) {
    next(err);
  }
});


/**
 * @openapi
 * /api/jobs/recommended:
 *   get:
 *     tags: [Jobs]
 *     summary: Get jobs recommended for the current student
 *     security:
 *       - bearerAuth: []
 */

  router.get(
  "/recommended",
  authRequired,
  async (req, res, next) => {
    try {
      // Only students can receive job recommendations
      if (req.user.role !== "student") {
        return res.status(403).json({
          error: "Only students can view recommended jobs.",
        });
      }

      // 1. Get current student
      const student = await repo.users.findById(req.user.sub);

      if (!student) {
        return res.status(404).json({
          error: "Student not found.",
        });
      }

      // 2. Student must have selected a domain
      if (!student.domain_role_id) {
        return res.json({
          jobs: [],
          message: "Student has not selected a career domain.",
        });
      }

      // 3. Get student's domain role
      const domainRoles = await repo.domainRoles.list();

      const studentDomain = domainRoles.find(
        (role) =>
          String(role.domain_role_id) ===
          String(student.domain_role_id)
      );

      if (!studentDomain) {
        return res.json({
          jobs: [],
          message: "Student domain role was not found.",
        });
      }

      // 4. Get all jobs
      const jobs = await repo.jobs.list();


      const recommendedJobs = [];

      // 5. Show open jobs matching student's domain
      for (const job of jobs) {
        if (job.status !== "open" || isJobExpired(job)) {
          continue;
        }

        const jobRole =
          job.title?.trim().toLowerCase();

        const studentRole =
          studentDomain.domain_name
            ?.trim()
            .toLowerCase();



        if (jobRole !== studentRole) {
          continue;
        }

        recommendedJobs.push({
          ...job,
          eligible: true,
          match_reason:
            "This job matches your selected career domain.",
        });
      }

      // Newest jobs first
      recommendedJobs.sort(
        (a, b) =>
          new Date(b.created_at) -
          new Date(a.created_at)
      );

      return res.json({
        jobs: recommendedJobs,
        count: recommendedJobs.length,
      });

    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/",
  authRequired,
  permissionRequired("jobs:create"),
  async (req, res, next) => {
    try {
      const {
  title,
  description,
  responsibilities,
  required_skills,
  preferred_skills,
  qualification,
  eligible_branches,
  employment_type,
  work_mode,
  location,
  salary,
  application_deadline,
  status,
  require_video,
  video_max_duration,
  video_prompt
} = req.body || {};
      if (!title) {
        return res.status(400).json({
          error: "Title is required.",
        });
      }

      if (
        required_skills &&
        !Array.isArray(required_skills)
      ) {
        return res.status(400).json({
          error: "required_skills must be an array.",
        });
      }

      if (
        status &&
        !["open", "closed", "draft"].includes(status)
      ) {
        return res.status(400).json({
          error: "Invalid job status.",
        });
      }

      let domain_role_id = req.body.domain_role_id || null;

      if (!domain_role_id && title) {
        try {
          const matchedDomain = await repo.prisma.domainRole.findFirst({
            where: {
              domain_name: {
                equals: title,
                mode: "insensitive",
              },
            },
            select: {
              domain_role_id: true,
            },
          });

          if (matchedDomain) {
            domain_role_id = matchedDomain.domain_role_id;
          }
        } catch {}
      }

      const job = await repo.jobs.create({
        employer_id: req.user.sub,
        title,
        description: description || null,
        responsibilities: responsibilities || null,
        required_skills: required_skills || [],
        preferred_skills: preferred_skills || [],
        qualification: qualification || null,
        eligible_branches: eligible_branches || [],
        employment_type: employment_type || null,
        work_mode: work_mode || null,
        location: location || null,
        salary: salary || null,
        application_deadline: application_deadline || null,
        status: status || "open",
        require_video: Boolean(require_video),
        video_max_duration: video_max_duration
          ? Number(video_max_duration)
          : 60,
        video_prompt: video_prompt || null,
        domain_role_id: domain_role_id || null,
      });

      return res.status(201).json(job);

    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/jobs/{id}:
 *   patch:
 *     tags: [Jobs]
 *     summary: Update a job
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Jobs]
 *     summary: Delete a job
 *     security:
 *       - bearerAuth: []
 */

/**
 * Get eligible students for a job
 *
 * Matching:
 * 1. Job title -> domain_roles.domain_name
 * 2. Student domain_role_id must match the job domain
 * 3. Student must have a completed assessment
 * 4. Compare student skill levels with domain required skill levels
 * 5. Students with >= 70% match are eligible
 */


// --------------------------------------------------
// Get current student's job applications
// --------------------------------------------------
router.get(
  "/my-applications",
  authRequired,
  async (req, res, next) => {
    try {
      if (req.user.role !== "student") {
        return res.status(403).json({
          error: "Only students can use this endpoint.",
        });
      }

      const applications =
        await repo.applications.listByStudent(req.user.sub);

      const result = await Promise.all(
        applications.map(async (application) => {
          const job = await repo.jobs.findById(
            application.job_id
          );

          return {
            ...application,
            job: job
              ? {
                  id: job.id,
                  title: job.title,
                  status: job.status,
                  company: job.company || null,
                }
              : null,
          };
        })
      );

      return res.json(result);
    } catch (err) {
      next(err);
    }
  }
);


router.post(
  "/:id/invite",
  authRequired,
  permissionRequired("jobs:update"),
  async (req, res, next) => {
    try {
      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      // Employer can invite only for their own job
      if (job.employer_id !== req.user.sub) {
        return res.status(403).json({
          error: "You are not authorized to invite candidates for this job.",
        });
      }

      const { candidate_id, message } = req.body;

      if (!candidate_id) {
        return res.status(400).json({
          error: "candidate_id is required.",
        });
      }

      const candidate = await repo.users.findById(candidate_id);

      if (!candidate) {
        return res.status(404).json({
          error: "Candidate not found.",
        });
      }

      if (candidate.role !== "student") {
        return res.status(400).json({
          error: "Only students can be invited.",
        });
      }

      const notification = await repo.notifications.create({
        user_id:candidate.id,
        job_id: job.id,
        type :"job_invitation",
        message:
          message ||
          `You have been invited to apply for ${job.title}.`,
           expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      return res.status(201).json({
        message: "Candidate invited successfully.",
        notification,
      });
    } catch (err) {
      next(err);
    }
  }
);


router.get(
  "/:id/eligible-students",
  authRequired,
  async (req, res, next) => {

    const routeStartedAt = Date.now();


    try {
       console.log(" ELIGIBLE STUDENTS API HIT:", req.params.id);

      // 1. Get the job
      const job = await repo.jobs.findById(req.params.id);
      console.log(" JOB FOUND:", job);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      // 2. Only the employer who owns the job or admin can view matches

      console.log("JOB EMPLOYER ID:", job.employer_id);
console.log("LOGGED USER ID:", req.user.sub);
console.log("LOGGED USER ROLE:", req.user.role);
console.log(
  "IS OWNER:",
  String(job.employer_id) === String(req.user.sub)
);
      const isOwner = job.employer_id === req.user.sub;
      const isAdmin = req.user.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "You are not authorized to view eligible students for this job.",
        });
      }

      // 3. Find the domain role using the job title
      const domainRoles = await repo.domainRoles.list();

      const domainRole = domainRoles.find(
        (role) =>
          role.domain_name?.trim().toLowerCase() ===
          job.title?.trim().toLowerCase()
      );
      console.log("DOMAIN ROLES:", domainRoles);
       console.log("MATCHED DOMAIN ROLE:", domainRole);

      if (!domainRole) {
        return res.status(404).json({
          error: `No domain role found for job title "${job.title}".`,
        });
      }

      // 4. Get required skills for this domain
      const requiredSkills =
        await repo.domainRequiredSkills.findByDomainRoleId(
          domainRole.domain_role_id || domainRole.id
        );

const hasRequiredSkills = requiredSkills.length > 0;

      // 5. Get active students
      const students = await repo.users.list({
        role: "student",
        status: "active",
      });

      // Only students belonging to the same domain role
      const domainStudents = students.filter(
        (student) =>
          student.domain_role_id ===
          (domainRole.domain_role_id || domainRole.id)
      );

  // --------------------------------------------------
// Remove students who have already applied for this job
// --------------------------------------------------
const applications =
  await repo.applications.listByJob(req.params.id);


  const getApplicationData = async (studentId) => {
  const application = applications.find(
    (app) => String(app.student_id) === String(studentId)
  );

  if (!application) {
    return {
      application_id: null,
      application_status: null,
      interview: null,
    };
  }

  const interview =
    await repo.interviews.findByApplication(application.id);

  return {
    application_id: application.id,
    application_status: application.status,
    interview: interview || null,
  };
};

const appliedStudentIds = new Set(
  applications.map((application) =>
    String(application.student_id)
  )
);

const unappliedDomainStudents = domainStudents;

console.log(
  "ALL STUDENTS:",
  students.map((s) => ({
    id: s.id,
    name: s.name,
    email: s.email,
    domain_role_id: s.domain_role_id,
  }))
);

console.log(
  "DOMAIN STUDENTS:",
  domainStudents.map((s) => ({
    id: s.id,
    name: s.name,
    email: s.email,
    domain_role_id: s.domain_role_id,
  }))
);

console.log("DOMAIN STUDENTS COUNT:", domainStudents.length);

     const results = [];

// Process a limited number of students concurrently.
// This prevents the eligible-students API from becoming
// increasingly slow as the number of students grows.
const STUDENT_CONCURRENCY = 5;

const processStudent = async (student) => {
  const matchedSkillNames = [];
  const missingSkillNames = [];
  const partialSkillNames = [];

  // --------------------------------------------------
  // CASE 1: Job/domain has NO required skills
  // --------------------------------------------------

  if (!hasRequiredSkills) {
    console.log(
      "NO REQUIRED SKILLS - INCLUDING STUDENT:",
      student.email
    );

    const applicationData =
      await getApplicationData(student.id);

    return {
      id: student.id,
      name:
      student.name && student.name.trim().toLowerCase() !== "user"
      ? student.name
      : student.username || student.name,
      email: student.email,
      domain_role_id: student.domain_role_id,

      domain_role:
        student.domainRole?.domain_name || job.title,

      skill_match: 0,
      fit_category: "Possible Fit",

      matched_skills: [],
      missing_skills: [],
      partial_skills: [],

      application_id: applicationData.application_id,
      application_status:
        applicationData.application_status,
      interview: applicationData.interview,

      eligible: true,
    };
  }

  // --------------------------------------------------
  // CASE 2: Job/domain HAS required skills
  // --------------------------------------------------

  // These two operations don't depend on each other,
  // so run them together.
  const [completedSession, applicationData] =
    await Promise.all([
      repo.quizSessions.findCompletedByUser(student.id),
      getApplicationData(student.id),
    ]);

  console.log("SESSION:", {
    email: student.email,
    session: completedSession,
  });

  // Keep existing behavior:
  // skill-based matching requires completed assessment.
  if (!completedSession) {
    return null;
  }

  console.log("STUDENT SESSION CHECK:", {
    name: student.name,
    email: student.email,
    user_id: student.id,
    session: completedSession,
  });

  const skillResults =
    await repo.studentSkillResults.findBySessionId(
      completedSession.session_id
    );

  const studentSkillMap = new Map();

  for (const result of skillResults) {
    studentSkillMap.set(Number(result.skill_id), {
      percentage: Number(result.percentage || 0),
      skill_level: Number(result.skill_level || 0),
    });
  }

  let totalScore = 0;
  let matchedSkills = 0;

  for (const requiredSkill of requiredSkills) {
    const requiredLevel = Number(
      requiredSkill.required_level || 0
    );

    const studentResult =
      studentSkillMap.get(
        Number(requiredSkill.skill_id)
      );

    const studentLevel =
      studentResult?.skill_level || 0;

    console.log("SKILL MATCH CHECK:", {
      student: student.name,
      email: student.email,
      skill: requiredSkill.skill?.skill_name,
      requiredLevel,
      studentLevel,
    });

    if (requiredLevel <= 0) {
      matchedSkills++;
      totalScore += 1;

      matchedSkillNames.push(
        requiredSkill.skill?.skill_name
      );
    } else {
      const matchRatio = Math.min(
        studentLevel / requiredLevel,
        1
      );

      totalScore += matchRatio;
      matchedSkills++;

      if (!studentResult) {
        missingSkillNames.push(
          requiredSkill.skill?.skill_name
        );
      } else if (studentLevel >= requiredLevel) {
        matchedSkillNames.push(
          requiredSkill.skill?.skill_name
        );
      } else {
        partialSkillNames.push({
          skill: requiredSkill.skill?.skill_name,
          student_level: studentLevel,
          required_level: requiredLevel,
        });
      }
    }
  }

  const skillMatch =
    matchedSkills > 0
      ? Math.round(
          (totalScore / matchedSkills) * 100
        )
      : 0;

  let fitCategory;

  if (skillMatch >= 80) {
    fitCategory = "Strong Fit";
  } else if (skillMatch >= 60) {
    fitCategory = "Good Fit";
  } else {
    fitCategory = "Possible Fit";
  }




  return {
  id: student.id,
  name:
    student.name &&
    student.name.trim().toLowerCase() !== "user"
      ? student.name
      : student.username || student.name,
  email: student.email,
    domain_role_id: student.domain_role_id,

    domain_role:
      student.domainRole?.domain_name || job.title,

    skill_match: skillMatch,
    fit_category: fitCategory,
    ai_hiring_match: null,

    matched_skills: matchedSkillNames,
    missing_skills: missingSkillNames,
    partial_skills: partialSkillNames,

    application_id:
      applicationData.application_id,

    application_status:
      applicationData.application_status,

    interview:
      applicationData.interview,

    eligible: true,
  };
};

// --------------------------------------------------
// Controlled concurrency
// --------------------------------------------------

for (
  let i = 0;
  i < domainStudents.length;
  i += STUDENT_CONCURRENCY
) {
  const batch =
    domainStudents.slice(
      i,
      i + STUDENT_CONCURRENCY
    );

  console.log(
    `[Eligible Students] Processing batch ${
      Math.floor(i / STUDENT_CONCURRENCY) + 1
    } with ${batch.length} students`
  );

  const batchResults =
    await Promise.all(
      batch.map((student) =>
        processStudent(student)
      )
    );

  results.push(
    ...batchResults.filter(Boolean)
  );
}

// ========================================
// AFTER ALL STUDENTS ARE PROCESSED
// ========================================


const skillsInsightsMap = new Map();

for (const student of domainStudents) {
  const completedSession =
    await repo.quizSessions.findCompletedByUser(student.id);

  if (!completedSession) continue;

  const skillResults =
    await repo.studentSkillResults.findBySessionId(
      completedSession.session_id
    );

  const studentSkillMap = new Map();

  for (const result of skillResults) {
    studentSkillMap.set(Number(result.skill_id), {
      percentage: Number(result.percentage || 0),
      skill_level: Number(result.skill_level || 0),
    });
  }

  for (const requiredSkill of requiredSkills) {
    const skillName =
      requiredSkill.skill?.skill_name;

    if (!skillName) continue;

    const requiredLevel = Number(
      requiredSkill.required_level || 0
    );

    const studentResult =
      studentSkillMap.get(
        Number(requiredSkill.skill_id)
      );

    if (!studentResult) continue;

    if (!skillsInsightsMap.has(skillName)) {
      skillsInsightsMap.set(skillName, {
        totalPercentage: 0,
        totalLevel: 0,
        candidates: 0,
        qualifiedCandidates: 0,
        requiredLevel,
      });
    }

    const insight =
      skillsInsightsMap.get(skillName);

    insight.totalPercentage +=
      studentResult.percentage;

    insight.totalLevel +=
      studentResult.skill_level;

    insight.candidates += 1;

    if (
      studentResult.skill_level >=
      requiredLevel
    ) {
      insight.qualifiedCandidates += 1;
    }
  }
}

const skillsInsights =
  Array.from(skillsInsightsMap.entries()).map(
    ([skill, data]) => ({
      skill,

      value:
        data.candidates > 0
          ? Math.round(
              data.totalPercentage /
                data.candidates
            )
          : 0,

      averageLevel:
        data.candidates > 0
          ? Number(
              (
                data.totalLevel /
                data.candidates
              ).toFixed(1)
            )
          : 0,

      requiredLevel: data.requiredLevel,

      assessedCandidates: data.candidates,

      qualifiedCandidates:
        data.qualifiedCandidates,
    })
  );
results.sort(
  (a, b) => b.skill_match - a.skill_match
);

return res.json({
  job: {
    id: job.id,
    title: job.title,
  },

  domain_role: {
    id: domainRole.domain_role_id || domainRole.id,
    name: domainRole.domain_name,
  },

  eligible_students: results,
  count: results.length,
  skillsInsights,
});

    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:id",
  authRequired,
  async (req, res, next) => {
    try {
      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      return res.json(job);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:id",
  authRequired,
  permissionRequired("jobs:update"),
  async (req, res, next) => {
    try {
      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      const isOwner = job.employer_id === req.user.sub;
      const isAdmin = req.user.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "You are not authorized to update this job.",
        });
      }

const allowed = [
  "title",
  "description",
  "responsibilities",
  "required_skills",
  "preferred_skills",
  "qualification",
  "eligible_branches",
  "employment_type",
  "work_mode",
  "location",
  "salary",
  "application_deadline",
  "status",
  "require_video",
  "video_max_duration",
  "video_prompt",
];

      const data = {};

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          data[key] = req.body[key];
        }
      }

      if (
        data.required_skills &&
        !Array.isArray(data.required_skills)
      ) {
        return res.status(400).json({
          error: "required_skills must be an array.",
        });
      }

if (
  data.preferred_skills &&
  !Array.isArray(data.preferred_skills)
) {
  return res.status(400).json({
    error: "preferred_skills must be an array.",
  });
}

if (
  data.eligible_branches &&
  !Array.isArray(data.eligible_branches)
) {
  return res.status(400).json({
    error: "eligible_branches must be an array.",
  });
}


      if (
        data.status &&
        !["open", "closed", "draft"].includes(data.status)
      ) {
        return res.status(400).json({
          error: "Invalid job status.",
        });
      }

      const updated = await repo.jobs.update(
        req.params.id,
        data
      );

      return res.json(updated);

    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:id",
  authRequired,
  permissionRequired("jobs:delete"),
  async (req, res, next) => {
    try {
      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      const isOwner = job.employer_id === req.user.sub;
      const isAdmin = req.user.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "You are not authorized to delete this job.",
        });
      }

      await repo.jobs.remove(req.params.id);

      return res.status(204).end();

    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/jobs/{id}/apply:
 *   post:
 *     tags: [Jobs]
 *     summary: Apply for a job
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       201:
 *         description: Application submitted
 */

// --------------------------------------------------
// Generate presigned B2 URL for student video upload
// --------------------------------------------------
router.post(
  "/:id/application-video-upload-url",
  authRequired,
  async (req, res, next) => {
    try {
      if (req.user.role !== "student") {
        return res.status(403).json({
          error: "Only students can upload application videos.",
        });
      }

      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      if (job.status !== "open") {
        return res.status(400).json({
          error: "This job is not accepting applications.",
        });
      }

      if (
        job.application_deadline &&
        new Date(job.application_deadline) < new Date()
      ) {
        return res.status(400).json({
          error: "The application deadline for this job has passed.",
        });
      }

      const existing = await repo.applications.findOne(
        job.id,
        req.user.sub
      );

      if (existing) {
        return res.status(409).json({
          error: "You have already applied for this job.",
        });
      }

      const {
        file_name,
        file_type,
        file_size,
      } = req.body || {};

      if (!file_name || !file_type || !file_size) {
        return res.status(400).json({
          error: "Video file information is required.",
        });
      }

      if (!String(file_type).startsWith("video/")) {
        return res.status(400).json({
          error: "Only video files are allowed.",
        });
      }

      const size = Number(file_size);

      if (!Number.isFinite(size) || size <= 0) {
        return res.status(400).json({
          error: "Invalid video file size.",
        });
      }

      const maxVideoSize = 100 * 1024 * 1024;

      if (size > maxVideoSize) {
        return res.status(400).json({
          error: "Video file must be 100 MB or smaller.",
        });
      }

      const safeFileName = path
        .basename(String(file_name))
        .replace(/[^a-zA-Z0-9._-]/g, "_");

      const videoKey =
        `applications/${job.id}/${req.user.sub}/${Date.now()}-${safeFileName}`;

      const command = new PutObjectCommand({
        Bucket: process.env.B2_BUCKET_NAME,
        Key: videoKey,
        ContentType: file_type,
      });

      const uploadUrl = await getSignedUrl(
        b2Client,
        command,
        {
          expiresIn: 600,
          signableHeaders: new Set(["content-type"]),
        }
      );

      return res.json({
        upload_url: uploadUrl,
        key: videoKey,
        file_name: file_name,
        file_type: file_type,
        file_size: size,
        storage: "backblaze_b2",
      });
    } catch (err) {
      next(err);
    }
  }
);



router.post(
  "/:id/apply",
  authRequired,
  uploadApplicationFiles.fields([
  { name: "resume", maxCount: 1 },
  { name: "video", maxCount: 1 },
]),
  async (req, res, next) => {
    try {
      if (req.user.role !== "student") {
        return res.status(403).json({
          error: "Only students can apply for jobs.",
        });
      }

      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      if (job.status !== "open") {
        return res.status(400).json({
          error: "This job is not accepting applications.",
        });
      }

      if (
     job.application_deadline &&
     new Date(job.application_deadline) < new Date()
      ) {
      await repo.jobs.update(job.id, {
      status: "closed",
      });

     return res.status(400).json({
    error: "The application deadline for this job has passed.",
      });
      }

      const existing = await repo.applications.findOne(
        job.id,
        req.user.sub
      );

      if (existing) {
        return res.status(409).json({
          error: "You have already applied for this job.",
        });
      }

      // --------------------------------------------
      // Parse application data from FormData
      // --------------------------------------------

      let applicationData = {};

if (req.body?.application_data) {
  try {
    applicationData = JSON.parse(
      req.body.application_data
    );
  } catch (err) {
    return res.status(400).json({
      error: "Invalid application data.",
    });
  }
}


// --------------------------------------------
// Uploaded files
// --------------------------------------------

const resumeFile = req.files?.resume?.[0];
const videoFile = req.files?.video?.[0];

// --------------------------------------------
// Resume information
// --------------------------------------------

if (resumeFile) {
  const extension = path.extname(resumeFile.originalname);

  const storedName =
    `${req.user.sub}-${Date.now()}${extension}`;

  const resumeDirectory = path.join(
    __dirname,
    "../../uploads/resumes"
  );

  fs.mkdirSync(resumeDirectory, {
    recursive: true,
  });

  const resumePath = path.join(
    resumeDirectory,
    storedName
  );

  fs.writeFileSync(
    resumePath,
    resumeFile.buffer
  );

  applicationData.resume = {
    file_name: resumeFile.originalname,
    stored_name: storedName,
    file_type: resumeFile.mimetype,
    file_size: resumeFile.size,
    url: `/uploads/resumes/${storedName}`,
  };
} else {
  // Use the student's profile resume
  const profile = await repo.profiles.findByUserId(
    req.user.sub
  );

  if (profile?.resume) {
    applicationData.resume = {
      ...profile.resume,
    };
  }
}

// --------------------------------------------
// Video → Backblaze B2
// --------------------------------------------
// --------------------------------------------
// Video → Backblaze B2
// --------------------------------------------

if (videoFile) {
  // Backward-compatible path:
  // If an old client still sends the video to the backend,
  // keep supporting it.
  const videoKey =
    `applications/${job.id}/${req.user.sub}/${Date.now()}-${videoFile.originalname}`;

  await b2Client.send(
    new PutObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: videoKey,
      Body: videoFile.buffer,
      ContentType: videoFile.mimetype,
    })
  );

  applicationData.video = {
    file_name: videoFile.originalname,
    file_type: videoFile.mimetype,
    file_size: videoFile.size,
    storage: "backblaze_b2",
    key: videoKey,
  };
} else if (job.require_video){
  const uploadedVideo = applicationData.video;

  if (!uploadedVideo?.key) {
    return res.status(400).json({
      error: "Video introduction is required.",
    });
  }

  const expectedPrefix =
    `applications/${job.id}/${req.user.sub}/`;

  if (!uploadedVideo.key.startsWith(expectedPrefix)) {
    return res.status(403).json({
      error: "Invalid application video.",
    });
  }

  try {
    const videoObject = await b2Client.send(
      new HeadObjectCommand({
        Bucket: process.env.B2_BUCKET_NAME,
        Key: uploadedVideo.key,
      })
    );

    applicationData.video = {
      file_name: uploadedVideo.file_name,
      file_type:
        videoObject.ContentType ||
        uploadedVideo.file_type ||
        "video/webm",
      file_size:
        videoObject.ContentLength ||
        uploadedVideo.file_size,
      storage: "backblaze_b2",
      key: uploadedVideo.key,
    };
  } catch (err) {
    return res.status(400).json({
      error: "Video upload was not completed. Please upload the video again.",
    });
  }
}

      // --------------------------------------------
      // Skill match
      // --------------------------------------------

      const skill_match =
        typeof applicationData.skill_match === "number"
          ? applicationData.skill_match
          : 70;

      // --------------------------------------------
      // Create application
      // --------------------------------------------
      const application =
        await repo.applications.create({
          job_id: job.id,
          student_id: req.user.sub,
          status: "submitted",
          skill_match,
          application_data: applicationData,
        });

      // --------------------------------------------
      // Notify employer
      // --------------------------------------------
      await repo.notifications.create({
        user_id: job.employer_id,
        type: "application",
        message: `New application for ${job.title}`,
      });

      return res.status(201).json(application);

    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/jobs/{id}/applications:
 *   get:
 *     tags: [Jobs]
 *     summary: List job applications
 *     security:
 *       - bearerAuth: []
 */

router.get(
  "/:id/applications",
  authRequired,
  permissionRequired("jobs:view-applications"),
  async (req, res, next) => {
    try {
      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      const isOwner = job.employer_id === req.user.sub;
      const isAdmin = req.user.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error:
            "You are not authorized to view these applications.",
        });
      }

      const result =
  await repo.applications.listByJobWithStudent(
    req.params.id
  );
      return res.json(result);

    } catch (err) {
      next(err);
    }
  }
);


router.get(
  "/:jobId/applications/:applicationId/video",
  authRequired,

  permissionRequired("jobs:view-applications"),
  async (req, res, next) => {
    try {
      const { jobId, applicationId } = req.params;

      const job = await repo.jobs.findById(jobId);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }


      const application =
  await repo.applications.findById(applicationId);

if (!application || application.job_id !== jobId) {
  return res.status(404).json({
    error: "Application not found.",
  });
}

const isStudent = req.user.role === "student";
const isOwner = job.employer_id === req.user.sub;
const isAdmin =
  req.user.role === "admin" ||
  req.user.role === "super_admin";

// Student can only view their own application video
if (isStudent && String(application.student_id) !== String(req.user.sub)) {
  return res.status(403).json({
    error: "You are not authorized to view this video.",
  });
}

// Only the job owner or admin can access other applicants' videos
if (!isStudent && !isOwner && !isAdmin) {
  return res.status(403).json({
    error: "You are not authorized to view this video.",
  });
}

    const videoKey =
        application.application_data?.video?.key;

      if (!videoKey) {
        return res.status(404).json({
          error: "No video found for this application.",
        });
      }

      const videoType =
        application.application_data?.video?.file_name
          ?.toLowerCase()
          .endsWith(".webm")
          ? "video/webm"
          : application.application_data?.video?.file_type ||
            "video/mp4";

      const command = new GetObjectCommand({
        Bucket: process.env.B2_BUCKET_NAME,
        Key: videoKey,
        ResponseContentType: videoType,
        ResponseContentDisposition: "inline",
      });

      const url = await getSignedUrl(
        b2Client,
        command,
        {
          expiresIn: 300,
        }
      );

      return res.json({ url });
    } catch (err) {
      next(err);
    }
  }
);


// --------------------------------------------------
// Schedule interview for a shortlisted application
// --------------------------------------------------
router.post(
  "/:id/applications/:applicationId/interview",
  authRequired,
  permissionRequired("jobs:view-applications"),
  async (req, res, next) => {
    try {
      const { scheduled_at, duration, interview_type, meeting_link, notes } =
        req.body || {};

      // 1. Find the job
      const job = await repo.jobs.findById(req.params.id);

      if (!job) {
        return res.status(404).json({
          error: "Job not found.",
        });
      }

      // 2. Verify employer owns this job
      const isOwner = job.employer_id === req.user.sub;
      const isAdmin =
        req.user.role === "admin" ||
        req.user.role === "super_admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error:
            "You are not authorized to schedule interviews for this job.",
        });
      }

      // 3. Find the application
      const applications =
        await repo.applications.listByJob(req.params.id);

      const application = applications.find(
        (item) => item.id === req.params.applicationId
      );

      if (!application) {
        return res.status(404).json({
          error: "Application not found for this job.",
        });
      }

      // 4. Only shortlisted candidates can be scheduled
      if (application.status !== "shortlisted") {
        return res.status(409).json({
          error:
            "Interview can only be scheduled for a shortlisted candidate.",
        });
      }

      // 5. Validate scheduled date/time
      if (!scheduled_at) {
        return res.status(400).json({
          error: "scheduled_at is required.",
        });
      }

      const scheduledDate = new Date(scheduled_at);

      if (Number.isNaN(scheduledDate.getTime())) {
        return res.status(400).json({
          error: "scheduled_at must be a valid date and time.",
        });
      }

      if (scheduledDate <= new Date()) {
        return res.status(400).json({
          error: "Interview must be scheduled for a future date and time.",
        });
      }

      // 6. Validate duration
      const interviewDuration = Number(duration ?? 30);

      if (
        !Number.isInteger(interviewDuration) ||
        interviewDuration <= 0 ||
        interviewDuration > 480
      ) {
        return res.status(400).json({
          error: "duration must be between 1 and 480 minutes.",
        });
      }

      // 7. Validate interview type
      const allowedInterviewTypes = [
        "online",
        "in-person",
      ];

      const interviewType = interview_type || "online";

      if (!allowedInterviewTypes.includes(interviewType)) {
        return res.status(400).json({
          error:
            "interview_type must be either 'online' or 'in-person'.",
        });
      }

      // 8. Online interviews should have a meeting link
      if (interviewType === "online") {
  if (!meeting_link || !String(meeting_link).trim()) {

    return res.status(400).json({
      error: "Meeting link is required for an online interview.",
    });
  }

  try {
    new URL(String(meeting_link).trim());
  } catch {
    return res.status(400).json({
      error: "Please provide a valid meeting URL.",
    });
  }
}

      // 9. Prevent duplicate active interview
      const existingInterview =
        await repo.interviews.findByApplication(
          application.id
        );

      if (
        existingInterview &&
        ["scheduled", "rescheduled"].includes(
          existingInterview.status
        )
      ) {
        return res.status(409).json({
          error:
            "An active interview is already scheduled for this application.",
          interview: existingInterview,
        });
      }

      // 10. Create interview
      const interview = await repo.interviews.create({
        application_id: application.id,
        scheduled_at: scheduledDate,
        duration: interviewDuration,
        interview_type: interviewType,
        meeting_link:
          meeting_link?.trim() || null,
        status: "scheduled",
        notes: notes?.trim() || null,
      });



  let emailSent = false;

  try {
    const student = await repo.users.findById(application.student_id);

    if (student?.email) {
      const interviewDate = scheduledDate.toLocaleString("en-IN", {
        dateStyle: "full",
        timeStyle: "short",
      });

      await sendEmail({
        to: student.email,
        subject: `Interview Invitation - ${job.title}`,

        text: `
  Hi ${student.name || "Candidate"},

  You have been shortlisted for the ${job.title} position at Vayvora Mentor Network.

  Your interview has been scheduled.

  Interview Date & Time: ${interviewDate}
  Duration: ${interviewDuration} minutes
  Interview Type: ${interviewType}
  ${meeting_link ? `Meeting Link: ${meeting_link}` : ""}
  ${notes ? `Notes: ${notes}` : ""}

  Please make sure you are available at the scheduled time.

  Regards,
  Vayvora Mentor Network
        `.trim(),

        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#334155;">
            <h2 style="color:#2563eb;">
              Interview Invitation
            </h2>

            <p>
              Hi ${student.name || "Candidate"},
            </p>

            <p>
              You have been shortlisted for the
              <strong>${job.title}</strong> position at
              <strong>Vayvora Mentor Network</strong>.
            </p>

            <h3>Interview Details</h3>

            <p>
              <strong>Date & Time:</strong> ${interviewDate}<br />
              <strong>Duration:</strong> ${interviewDuration} minutes<br />
              <strong>Interview Type:</strong> ${interviewType}
            </p>

            ${
              meeting_link
                ? `
                  <p>
                    <strong>Meeting Link:</strong><br />
                    <a href="${meeting_link}">
                      ${meeting_link}
                    </a>
                  </p>
                `
                : ""
            }

            ${
              notes
                ? `
                  <p>
                    <strong>Additional Notes:</strong><br />
                    ${notes}
                  </p>
                `
                : ""
            }

            <p>
              Please make sure you are available at the scheduled time.
            </p>

            <p>
              Regards,<br />
              <strong>Vayvora Mentor Network</strong>
            </p>
          </div>
        `,
      });

      emailSent = true;
    } else {
      console.warn(
        "[interview] Student does not have an email address:",
        application.student_id
      );
    }
  } catch (emailError) {
    // Do not fail interview scheduling if email delivery fails.
    console.error(
      "[interview] Interview created but invitation email failed:",
      emailError?.message || emailError
    );
  }

        //Notifications for Scheduled interview
        await repo.notifications.create({
    user_id: application.student_id,
    job_id: job.id,
    type: "interview_scheduled",
    message:
      `An interview has been scheduled for your application to "${job.title}" on ` +
      `${scheduledDate.toLocaleString()}.`,
  });

        return res.status(201).json({...interview,email_sent:emailSent});

      } catch (err) {
        next(err);
      }
    }
  );


  // --------------------------------------------------
  // Get current student's interview for a job
  // --------------------------------------------------
  router.get(
    "/:id/my-interview",
    authRequired,
    async (req, res, next) => {
      try {
        if (req.user.role !== "student") {
          return res.status(403).json({
            error: "Only students can use this endpoint.",
          });
        }

        const job = await repo.jobs.findById(req.params.id);

        if (!job) {
          return res.status(404).json({
            error: "Job not found.",
          });
        }

        const applications =
          await repo.applications.listByStudent(req.user.sub);

        const application = applications.find(
          (item) => item.job_id === job.id
        );

        if (!application) {
          return res.status(404).json({
            error: "You have not applied for this job.",
          });
        }

        const interview =
          await repo.interviews.findByApplication(
            application.id,
          );

        if (!interview) {
          return res.status(404).json({
            error: "No interview is scheduled for this application.",
          });
        }

        return res.json({
          interview,
          application_id: application.id,
          job_id: job.id,
          job_title: job.title,
        });
      } catch (err) {
        next(err);
      }
    }
  );



  // --------------------------------------------------
  // Get interview for an application
  // --------------------------------------------------
  router.get(
    "/:id/applications/:applicationId/interview",
    authRequired,
    async (req, res, next) => {
      try {
        const job = await repo.jobs.findById(req.params.id);

        if (!job) {
          return res.status(404).json({
            error: "Job not found.",
          });
        }

        const applications =
          await repo.applications.listByJob(req.params.id);

        const application = applications.find(
          (item) => item.id === req.params.applicationId
        );

        if (!application) {
          return res.status(404).json({
            error: "Application not found for this job.",
          });
        }

        const isOwner =
          job.employer_id === req.user.sub;

        const isAdmin =
          req.user.role === "admin" ||
          req.user.role === "super_admin";

        const isStudent =
          req.user.role === "student" &&
          application.student_id === req.user.sub;

        // Employer, admin, or the student who owns the application
        if (!isOwner && !isAdmin && !isStudent) {
          return res.status(403).json({
            error:
              "You are not authorized to view this interview.",
          });
        }

        const interview =
          await repo.interviews.findByApplication(
            application.id
          );

        if (!interview) {
          return res.status(404).json({
            error:
              "No interview is scheduled for this application.",
          });
        }

        return res.json(interview);
      } catch (err) {
        next(err);
      }
    }
  );

  // --------------------------------------------------
  // Update scheduled interview
  // --------------------------------------------------
  router.put(
    "/:id/applications/:applicationId/interview",
    authRequired,
    permissionRequired("jobs:view-applications"),
    async (req, res, next) => {
      try {
        const {
          scheduled_at,
          duration,
          interview_type,
          meeting_link,
          notes,
        } = req.body || {};

        const job = await repo.jobs.findById(req.params.id);

        if (!job) {
          return res.status(404).json({
            error: "Job not found.",
          });
        }

        const isOwner = job.employer_id === req.user.sub;
        const isAdmin =
          req.user.role === "admin" ||
          req.user.role === "super_admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({
            error:
              "You are not authorized to update interviews for this job.",
          });
        }

        const applications =
          await repo.applications.listByJob(req.params.id);

        const application = applications.find(
          (item) => item.id === req.params.applicationId
        );

        if (!application) {
          return res.status(404).json({
            error: "Application not found for this job.",
          });
        }

        const interview =
          await repo.interviews.findByApplication(
            application.id
          );

        if (!interview) {
          return res.status(404).json({
            error: "Interview not found.",
          });
        }

        if (interview.status === "cancelled") {
          return res.status(409).json({
            error: "Cancelled interviews cannot be edited.",
          });
        }

        const scheduledDate = new Date(scheduled_at);

        if (
          !scheduled_at ||
          Number.isNaN(scheduledDate.getTime())
        ) {
          return res.status(400).json({
            error: "A valid scheduled_at is required.",
          });
        }

        if (scheduledDate <= new Date()) {
          return res.status(400).json({
            error:
              "Interview must be scheduled for a future date and time.",
          });
        }

        const interviewDuration = Number(duration ?? 30);

        if (
          !Number.isInteger(interviewDuration) ||
          interviewDuration <= 0 ||
          interviewDuration > 480
        ) {
          return res.status(400).json({
            error: "duration must be between 1 and 480 minutes.",
          });
        }

        const allowedInterviewTypes = [
          "online",
          "in-person",
        ];

        const interviewType =
          interview_type || interview.interview_type;

        if (!allowedInterviewTypes.includes(interviewType)) {
          return res.status(400).json({
            error:
              "interview_type must be either 'online' or 'in-person'.",
          });
        }

        if (
          interviewType === "online" &&
          (!meeting_link || !String(meeting_link).trim())
        ) {
          return res.status(400).json({
            error:
              "meeting_link is required for an online interview.",
          });
        }

        const updatedInterview =
    await repo.interviews.update(
      interview.id,
      {
        scheduled_at: scheduledDate,
        duration: interviewDuration,
        interview_type: interviewType,
        meeting_link:
          meeting_link?.trim() || null,
        notes: notes?.trim() || null,
        status: "rescheduled",
      }
    );

  // Notify the student about the rescheduled interview
  await repo.notifications.create({
    user_id: application.student_id,
    job_id: job.id,
    type: "interview_rescheduled",
    message:
      `Your interview for "${job.title}" has been rescheduled to ` +
      `${scheduledDate.toLocaleString()}.`,
  });

  // Send rescheduled interview email
  let emailSent = false;

  try {
    const student = await repo.users.findById(
      application.student_id
    );

    if (student?.email) {
      const interviewDate = scheduledDate.toLocaleString("en-IN", {
        dateStyle: "full",
        timeStyle: "short",
      });

      await sendEmail({
        to: student.email,

        subject: `Interview Rescheduled - ${job.title}`,

        text: `
  Hi ${student.name || "Candidate"},

  Your interview for the ${job.title} position at Vayvora Mentor Network has been rescheduled.

  Updated Interview Details:

  Date & Time: ${interviewDate}
  Duration: ${interviewDuration} minutes
  Interview Type: ${interviewType}
  ${meeting_link ? `Meeting Link: ${meeting_link}` : ""}
  ${notes ? `Notes: ${notes}` : ""}

  Please make sure you are available at the updated time.

  Regards,
  Vayvora Mentor Network
        `.trim(),

        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#334155;">
            <h2 style="color:#2563eb;">
              Interview Rescheduled
            </h2>

            <p>
              Hi ${student.name || "Candidate"},
            </p>

            <p>
              Your interview for the
              <strong>${job.title}</strong>
              position at
              <strong>Vayvora Mentor Network</strong>
              has been rescheduled.
            </p>

            <h3>Updated Interview Details</h3>

            <p>
              <strong>Date & Time:</strong> ${interviewDate}<br />
              <strong>Duration:</strong> ${interviewDuration} minutes<br />
              <strong>Interview Type:</strong> ${interviewType}
            </p>

            ${
              meeting_link
                ? `
                  <p>
                    <strong>Meeting Link:</strong><br />
                    <a href="${meeting_link}">
                      ${meeting_link}
                    </a>
                  </p>
                `
                : ""
            }

            ${
              notes
                ? `
                  <p>
                    <strong>Notes:</strong><br />
                    ${notes}
                  </p>
                `
                : ""
            }

            <p>
              Please make sure you are available at the updated time.
            </p>

            <p>
              Regards,<br />
              <strong>Vayvora Mentor Network</strong>
            </p>
          </div>
        `,
      });

      emailSent = true;
    }
  } catch (emailError) {
    console.error(
      "[interview] Interview rescheduled but email failed:",
      emailError?.message || emailError
    );
  }

  return res.json({
    ...updatedInterview,
    email_sent: emailSent,
  });
      } catch (err) {
        next(err);
      }
    }
  );


  // --------------------------------------------------
  // Cancel scheduled interview
  // --------------------------------------------------
  router.delete(
    "/:id/applications/:applicationId/interview",
    authRequired,
    permissionRequired("jobs:view-applications"),
    async (req, res, next) => {
      try {
        const job = await repo.jobs.findById(req.params.id);

        if (!job) {
          return res.status(404).json({
            error: "Job not found.",
          });
        }

        const isOwner = job.employer_id === req.user.sub;
        const isAdmin =
          req.user.role === "admin" ||
          req.user.role === "super_admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({
            error:
              "You are not authorized to cancel interviews for this job.",
          });
        }

        const applications =
          await repo.applications.listByJob(req.params.id);

        const application = applications.find(
          (item) => item.id === req.params.applicationId
        );

        if (!application) {
          return res.status(404).json({
            error: "Application not found for this job.",
          });
        }

        const interview =
          await repo.interviews.findByApplication(
            application.id
          );

        if (!interview) {
          return res.status(404).json({
            error: "Interview not found.",
          });
        }

        if (interview.status === "cancelled") {
          return res.status(409).json({
            error: "Interview is already cancelled.",
          });
        }

        const updatedInterview =
    await repo.interviews.update(
      interview.id,
      {
        status: "cancelled",
      }
    );


  // Notify the student about the cancelled interview
  await repo.notifications.create({
    user_id: application.student_id,
    job_id: job.id,
    type: "interview_cancelled",
    message:
      `Your interview for "${job.title}" has been cancelled.`,
  });

  // Send cancellation email to the student
  let emailSent = false;

  try {
    const student = await repo.users.findById(
      application.student_id
    );

    if (student?.email) {
      const interviewDate = new Date(
        interview.scheduled_at
      ).toLocaleString("en-IN", {
        dateStyle: "full",
        timeStyle: "short",
      });

      await sendEmail({
        to: student.email,

        subject: `Interview Cancelled - ${job.title}`,

        text: `
  Hi ${student.name || "Candidate"},

  Your interview for the ${job.title} position at Vayvora Mentor Network has been cancelled.

  Previous Interview Date & Time: ${interviewDate}
  Interview Type: ${interview.interview_type || "N/A"}
  Duration: ${interview.duration || "N/A"} minutes

  If required, the employer may contact you with further information.

  Regards,
  Vayvora Mentor Network
        `.trim(),

        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#334155;">
            <h2 style="color:#dc2626;">
              Interview Cancelled
            </h2>

            <p>
              Hi ${student.name || "Candidate"},
            </p>

            <p>
              Your interview for the
              <strong>${job.title}</strong>
              position at
              <strong>Vayvora Mentor Network</strong>
              has been cancelled.
            </p>

            <h3>Previous Interview Details</h3>

            <p>
              <strong>Date & Time:</strong> ${interviewDate}<br />
              <strong>Interview Type:</strong>
              ${interview.interview_type || "N/A"}<br />
              <strong>Duration:</strong>
              ${interview.duration || "N/A"} minutes
            </p>

            <p>
              If required, the employer may contact you with further information.
            </p>

            <p>
              Regards,<br />
              <strong>Vayvora Mentor Network</strong>
            </p>
          </div>
        `,
      });

      emailSent = true;
    } else {
      console.warn(
        "[interview] Student does not have an email address:",
        application.student_id
      );
    }
  } catch (emailError) {
    console.error(
      "[interview] Interview cancelled but cancellation email failed:",
      emailError?.message || emailError
    );
  }

  return res.json({
    ...updatedInterview,
    email_sent: emailSent,
  });
      } catch (err) {
        next(err);
      }
    }
  );


  // --------------------------------------------------
  // Send email to an applicant
  // --------------------------------------------------
  router.post(
    "/:id/applications/:applicationId/email",
    authRequired,
    permissionRequired("jobs:view-applications"),
    async (req, res, next) => {
      try {
        const { subject, message } = req.body || {};

        // 1. Validate email content
        if (!subject || !String(subject).trim()) {
          return res.status(400).json({
            error: "Email subject is required.",
          });
        }

        if (!message || !String(message).trim()) {
          return res.status(400).json({
            error: "Email message is required.",
          });
        }

        // 2. Find the job
        const job = await repo.jobs.findById(req.params.id);

        if (!job) {
          return res.status(404).json({
            error: "Job not found.",
          });
        }

        // 3. Verify employer owns this job
        const isOwner = job.employer_id === req.user.sub;
        const isAdmin =
          req.user.role === "admin" ||
          req.user.role === "super_admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({
            error:
              "You are not authorized to email applicants for this job.",
          });
        }

        // 4. Find application
        const applications =
          await repo.applications.listByJob(req.params.id);

        const application = applications.find(
          (item) => item.id === req.params.applicationId
        );

        if (!application) {
          return res.status(404).json({
            error: "Application not found for this job.",
          });
        }

        // 5. Get student details
        const student =
          await repo.users.findById(application.student_id);

        if (!student) {
          return res.status(404).json({
            error: "Student not found.",
          });
        }

        if (!student.email) {
          return res.status(400).json({
            error: "Student does not have an email address.",
          });
        }

        // 6. Send email through existing SMTP service
        await sendEmail({
          to: student.email,
          subject: String(subject).trim(),
          text: String(message).trim(),
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
              <h2>Vayvora EduTech</h2>

              <p>${String(message)
                .trim()
                .replace(/\n/g, "<br />")}</p>

              <hr />

              <p style="color:#64748b;font-size:12px;">
                This email was sent by the employer through Vayvora EduTech.
              </p>
            </div>
          `,
        });

        return res.json({
          success: true,
          message: "Email sent successfully.",
        });
      } catch (err) {
        next(err);
      }
    }
  );



  /**
   * Update an application's hiring status
   *
   * Allowed statuses:
   * - submitted
   * - shortlisted
   * - rejected
   */
  /**
   * Update an application's hiring status
   *
   * If an application already exists:
   *   → update it
   *
   * If no application exists:
   *   → applicationId is treated as the student ID
   *   → create a pipeline/application record
   */
  router.patch(
    "/:id/applications/:applicationId/status",
    authRequired,
    permissionRequired("jobs:view-applications"),
    async (req, res, next) => {
      try {
        const { status } = req.body || {};
        const { id: jobId, applicationId } = req.params;

        const allowedStatuses = [
          "submitted",
          "shortlisted",
          "selected",
          "rejected",
        ];

        if (!allowedStatuses.includes(status)) {
          return res.status(400).json({
            error: "Invalid application status.",
          });
        }

        // --------------------------------------------
        // Find job
        // --------------------------------------------

        const job = await repo.jobs.findById(jobId);

        if (!job) {
          return res.status(404).json({
            error: "Job not found.",
          });
        }

        // --------------------------------------------
        // Authorization
        // --------------------------------------------

        const isOwner = job.employer_id === req.user.sub;
        const isAdmin = req.user.role === "admin";

        if (!isOwner && !isAdmin) {
          return res.status(403).json({
            error:
              "You are not authorized to update applications for this job.",
          });
        }

        // --------------------------------------------
        // Try to find existing application
        // --------------------------------------------

        let application =
          await repo.applications.findById(applicationId);

        // --------------------------------------------
        // Existing application
        // --------------------------------------------

        if (application) {
          // Make sure application belongs to this job
          if (application.job_id !== jobId) {
            return res.status(404).json({
              error: "Application not found for this job.",
            });
          }

          application = await repo.applications.update(
            application.id,
            { status }
          );
        } else {
          // --------------------------------------------
          // No application exists
          //
          // applicationId is actually the student ID.
          // Create a pipeline/application record.
          // --------------------------------------------

          const studentId = applicationId;

          // Prevent duplicate application records
          const existing =
            await repo.applications.findOne(
              jobId,
              studentId
            );

          if (existing) {
            application =
              await repo.applications.update(
                existing.id,
                { status }
              );
          } else {
            application =
              await repo.applications.create({
                job_id: jobId,
                student_id: studentId,
                status,
                skill_match: 0,
                application_data: {
                  source: "employer_pipeline",
                },
              });
          }
        }

        // --------------------------------------------
        // Notify student
        // --------------------------------------------

        await repo.notifications.create({
          user_id: application.student_id,
          type:
            status === "selected"
              ? "application_selected"
              : "application",
          message:
            status === "shortlisted"
              ? `You have been shortlisted for ${job.title}.`
              : status === "selected"
              ? `Congratulations! You have been selected for ${job.title}.`
              : status === "rejected"
              ? `Your application for ${job.title} was not selected to proceed.`
              : `Your application for ${job.title} is under review.`,
        });

        return res.json(application);
      } catch (err) {
        next(err);
      }
    }
  );

  module.exports = router;
