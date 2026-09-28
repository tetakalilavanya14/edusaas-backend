const express = require("express");
const repo = require("../data");
const uploadResume = require("../middleware/uploadResume");
const uploadAvatar = require("../middleware/uploadAvatar");
const {
  authRequired,
  roleRequired,
} = require("../middleware/auth");

const router = express.Router();

const { clerkClient, verifyToken } = require("@clerk/express");
const {
  generateAccessToken,
  generateRefreshToken,
} = require("../config/jwt");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/**
 * @openapi
 * /api/users/sync:
 *   post:
 *     tags: [Users]
 *     summary: Synchronize Clerk user to PostgreSQL DB
 *     security: [{ bearerAuth: [] }]
 */
router.post("/sync", async (req, res, next) => {
  console.log("[SYNC ROUTE HIT] Starting user sync process...");

  try {
    // Extract Bearer token from Authorization header
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        error: "Unauthorized: No token provided.",
      });
    }

    // Verify the Clerk JWT (session token) sent from the React frontend
    let clerkPayload;

    try {
      clerkPayload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
        clockSkewInMs: 60000,
      });
    } catch (verifyErr) {
      console.error(
        "[SYNC] Token verification failed:",
        verifyErr.message
      );

      return res.status(401).json({
        error: "Unauthorized: Invalid Clerk token.",
        detail: verifyErr.message,
      });
    }

    const clerkId = clerkPayload.sub;

    if (!clerkId) {
      return res.status(401).json({
        error: "Unauthorized: Missing valid Clerk session token.",
      });
    }

    console.log("[SYNC] Authenticated Clerk ID:", clerkId);

    const clerkUser = await clerkClient.users.getUser(clerkId);

    if (clerkUser.unsafeMetadata?.account_status === "deleted") {
      console.log(
        "[SYNC] Deleted Clerk account attempted login:",
        clerkId
      );

      return res.status(403).json({
        error: "This account has been deleted and cannot be used.",
      });
    }

    console.log(
      "[SYNC] Clerk User Data:",
      JSON.stringify({
        id: clerkUser.id,
        emailAddresses: clerkUser.emailAddresses,
        primaryEmailAddressId: clerkUser.primaryEmailAddressId,
        unsafeMetadata: clerkUser.unsafeMetadata,
      })
    );

    const primaryEmailObj = clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId
    );

    const email = primaryEmailObj
      ? primaryEmailObj.emailAddress.toLowerCase()
      : null;

    if (!email) {
      console.log("[SYNC] No primary email found!");

      return res.status(400).json({
        error: "Clerk user has no primary email",
      });
    }

    const name =
      `${clerkUser.firstName || ""} ${
        clerkUser.lastName || ""
      }`.trim() || "User";

    const username = clerkUser.username || null;

    const role =
      req.body.role ||
      clerkUser.unsafeMetadata.role ||
      "student";

    const domainRoleId =
      req.body.domainRoleId ||
      clerkUser.unsafeMetadata.domain_role_id ||
      null;

    console.log(
      "[SYNC] Parsed Data - Email:",
      email,
      "Name:",
      name,
      "Username:",
      username,
      "Role:",
      role,
      "Domain:",
      domainRoleId
    );

    let user = await repo.users.findByClerkId(clerkId);

    console.log("[SYNC] findByClerkId result:", user);

    if (user) {
      console.log(
        "[SYNC] Found existing PostgreSQL user by Clerk ID:",
        user.id,
        user.email
      );
    } else {
      console.log(
        "[SYNC] Clerk ID not found, checking email..."
      );

      user = await repo.users.findByEmail(email);

      if (user) {
        console.log(
          "[SYNC] Found existing PostgreSQL user by email:",
          user.id,
          user.email
        );
      }
    }

    // Block suspended users from receiving an EduSaaS access token
    if (user && user.status === "suspended") {
      console.log(
        "[SYNC] Suspended user attempted login:",
        user.id
      );

      return res.status(403).json({
        error:
          "Your account has been suspended. Please contact an administrator.",
      });
    }

    if (!user) {
      console.log(
        "[SYNC] Creating new user in postgres..."
      );

      const dummyPassword =
        crypto.randomBytes(16).toString("hex");

      const password_hash =
        await bcrypt.hash(dummyPassword, 10);

      try {
        user = await repo.users.create({
          name,
          username,
          clerk_id: clerkId,
          email,
          role,
          password_hash,
          domain_role_id:
            role === "student" ? domainRoleId : null,
        });

        console.log(
          "[SYNC] Successfully created user:",
          user.id
        );
      } catch (dbErr) {
        console.error(
          "[SYNC] Database Creation Error:",
          dbErr
        );

        throw dbErr;
      }

      if (role === "student") {
        await repo.profiles.upsert(user.id, {
          institution: null,
          company: null,
          preferences: {},
          initial_assessment_completed: false,
        });
      }
    } else {
      console.log(
        "[SYNC] User already exists in postgres:",
        user.id
      );

      let updateData = {};

      // Update clerk_id if they recreated their Clerk account
      if (user.clerk_id !== clerkId) {
        updateData.clerk_id = clerkId;
      }

      // Security: an existing user's role must not be changed by the client.
      // Role changes must come through trusted server/admin flows.
      if (
        req.body.role &&
        req.body.role !== user.role
      ) {
        console.warn(
          `[SYNC] Ignoring client-supplied role change for user ${user.id}: ${user.role} -> ${req.body.role}`
        );
      }

      const effectiveRole =
        updateData.role || user.role;

      const targetDomain =
        req.body.domainRoleId ||
        req.body.domain_role_id ||
        clerkUser.unsafeMetadata?.domain_role_id ||
        null;

      if (effectiveRole === "student") {
        if (
          targetDomain &&
          targetDomain !== user.domain_role_id
        ) {
          console.log(
            `[SYNC] Updating student domain_role_id from ${user.domain_role_id} to ${targetDomain}`
          );

          updateData.domain_role_id = targetDomain;
        } else if (!user.domain_role_id) {
          const allRoles =
            (await repo.domainRoles.list()) || [];

          const aiRole = allRoles.find(
            (r) => r.domain_name === "AI Engineer"
          );

          if (aiRole) {
            console.log(
              `[SYNC] Student missing domain_role_id; assigning default ${aiRole.domain_name}`
            );

            updateData.domain_role_id =
              aiRole.domain_role_id || aiRole.id;
          }
        }
      }

      // Apply updates to database if needed
      if (Object.keys(updateData).length > 0) {
        user = await repo.users.update(
          user.id,
          updateData
        );
      }

      // Sync postgres role UP to Clerk
      if (
        clerkUser.unsafeMetadata.role !== user.role
      ) {
        console.log(
          `[SYNC] Pushing Postgres role (${user.role}) back to Clerk metadata`
        );

        await clerkClient.users.updateUserMetadata(
          clerkId,
          {
            unsafeMetadata: {
              role: user.role,
              domain_role_id: user.domain_role_id,
            },
          }
        );
      }
    }

    await repo.users.touchLogin(user.id);

    const accessToken =
      generateAccessToken(user);

    const refreshToken =
      generateRefreshToken(user);

    const tokenDigest = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    const token_hash =
      await bcrypt.hash(tokenDigest, 10);

    const decodedRefreshToken =
      jwt.decode(refreshToken);

    await repo.refreshTokens.create({
      user_id: user.id,
      token_hash,
      expires_at: new Date(
        decodedRefreshToken.exp * 1000
      ),
    });

    console.log(
      "[SYNC] Sync completely successful!"
    );

    return res.json({
      accessToken,
      refreshToken,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error(
      "[SYNC] FATAL ERROR:",
      err
    );

    next(err);
  }
});

/**
 * @swagger
 * /api/users/search:
 *   get:
 *     summary: Search users by username
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  "/search",
  authRequired,
  async (req, res, next) => {
    try {
      const { q } = req.query;

      if (!q) {
        return res.status(400).json({
          error: "Search query 'q' is required",
        });
      }

      const results =
        await repo.users.searchByUsername(
          q,
          req.user.sub
        );

      res.json({
        success: true,
        data: results,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Remove sensitive fields before sending user data
 */
function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    clerk_id: user.clerk_id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    domain_role_id: user.domain_role_id,
    domain_role: user.domain_role,
    last_login: user.last_login,
    created_at: user.created_at,
  };
}

/**
 * @openapi
 * /api/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Fetch current authenticated user's profile
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  "/me",
  authRequired,
  async (req, res, next) => {
    try {
      const user =
        await repo.users.findById(
          req.user.sub
        );

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      const profile =
        await repo.profiles.findByUserId(
          user.id
        );

      return res.json({
        ...sanitizeUser(user),
        profile: profile || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Fetch user profile
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  "/:id",
  authRequired,
  async (req, res, next) => {
    try {
      const targetUserId =
        req.params.id === "me"
          ? req.user.sub
          : req.params.id;

      // Owner can view their own profile.
      const isOwner =
        String(req.user.sub) ===
        String(targetUserId);

      // Admins can view any profile.
      const isAdmin =
        req.user.role === "admin" ||
        req.user.role === "super_admin";

      // Fetch the target user once.
      const targetUser =
        await repo.users.findById(
          targetUserId
        );

      // Educators can view student profiles.
      const isAuthorizedEducator =
        req.user.role === "educator" &&
        targetUser?.role === "student";

      // Employers can view authorized student candidates.
      let isAuthorizedEmployer = false;

      if (
        req.user.role === "employer" &&
        !isOwner
      ) {
        const employerJobs =
          await repo.jobs.list({
            employer_id: req.user.sub,
          });

        if (
          targetUser?.role === "student"
        ) {
          // Authorization path 1:
          // Candidate belongs to a domain used by one of the employer's jobs.
          const hasMatchingDomainJob =
            employerJobs.some(
              (job) =>
                String(
                  targetUser.domain_role_id
                ) ===
                String(job.domain_role_id)
            );

          // Authorization path 2:
          // Candidate has applied to one of the employer's jobs.
          const candidateApplications =
            await repo.applications.listByStudent(
              targetUser.id
            );

          const hasEmployerApplication =
            candidateApplications.some(
              (application) =>
                employerJobs.some(
                  (job) =>
                    String(job.id) ===
                      String(
                        application.job_id
                      ) &&
                    String(
                      job.employer_id
                    ) ===
                      String(req.user.sub)
                )
            );

          isAuthorizedEmployer =
            hasMatchingDomainJob ||
            hasEmployerApplication;
        }
      }

      /*
       * Authorization:
       *
       * 1. User can view own profile
       * 2. Admin/super_admin can view profiles
       * 3. Educator can view student profiles
       * 4. Employer can view students matching
       *    an employer job domain or application
       */
      if (
        !isOwner &&
        !isAdmin &&
        !isAuthorizedEducator &&
        !isAuthorizedEmployer
      ) {
        return res.status(403).json({
          error:
            "You are not authorized to view this profile.",
        });
      }

      if (!targetUser) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      const profile =
        await repo.profiles.findByUserId(
          targetUser.id
        );

      return res.json({
        ...sanitizeUser(targetUser),
        profile: profile || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/users/{id}:
 *   patch:
 *     tags: [Users]
 *     summary: Update user basic details (e.g. name)
 *     security: [{ bearerAuth: [] }]
 */
router.patch(
  "/:id",
  authRequired,
  async (req, res, next) => {
    try {
      const requestedId =
        req.params.id === "me"
          ? req.user.sub
          : req.params.id;

      const user =
        await repo.users.findById(
          requestedId
        );

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      const isOwner =
        req.user.sub === user.id ||
        (user.clerk_id &&
          (req.user.clerk_id ===
            user.clerk_id ||
            req.user.sub ===
              user.clerk_id));

      if (
        !isOwner &&
        req.user.role !== "admin"
      ) {
        return res.status(403).json({
          error:
            "Cannot update another user's details.",
        });
      }

      const { name } = req.body;

      if (
        !name ||
        typeof name !== "string" ||
        !name.trim()
      ) {
        return res.status(400).json({
          error: "A valid name is required.",
        });
      }

      const trimmedName =
        name.trim();

      // 1. Update in PostgreSQL
      const updatedUser =
        await repo.users.update(
          user.id,
          {
            name: trimmedName,
          }
        );

      // 2. Best-effort update to Clerk
      if (user.clerk_id) {
        try {
          const parts =
            trimmedName.split(/\s+/);

          const firstName = parts[0];

          const lastName =
            parts
              .slice(1)
              .join(" ") ||
            undefined;

          await clerkClient.users.updateUser(
            user.clerk_id,
            {
              firstName,
              lastName,
            }
          );
        } catch (clerkErr) {
          console.warn(
            "[USERS] Could not update name in Clerk:",
            clerkErr.message
          );
        }
      }

      return res.json({
        success: true,
        user: sanitizeUser(
          updatedUser
        ),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/users/{id}/profile:
 *   put:
 *     tags: [Users]
 *     summary: Create or update extended profile info
 *     security: [{ bearerAuth: [] }]
 */
router.put(
  "/:id/profile",
  authRequired,
  async (req, res, next) => {
    try {
      const requestedId =
        req.params.id === "me"
          ? req.user.sub
          : req.params.id;

      const user =
        await repo.users.findById(
          requestedId
        );

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      // Only owner or admin
      const isOwner =
        req.user.sub === user.id ||
        (user.clerk_id &&
          (req.user.clerk_id ===
            user.clerk_id ||
            req.user.sub ===
              user.clerk_id));

      const isAdmin =
        req.user.role === "admin" ||
        req.user.role === "super_admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error:
            "Cannot update another user's profile.",
        });
      }

      const allowedFields = [
        "career_goal",
        "institution",
        "company",
        "preferences",
      ];

      const data = {};

      for (const field of allowedFields) {
        if (
          req.body[field] !==
          undefined
        ) {
          data[field] =
            req.body[field];
        }
      }

      // Support educator, employer, and admin fields
      const extraFields = [
        "specialization",
        "title",
        "bio",
        "industry",
        "location",
        "website",
        "about_company",
        "company_bio",
        "department",
        "clearance",
        "office_location",
        "admin_scope",
      ];

      const hasExtraFields =
        extraFields.some(
          (f) =>
            req.body[f] !==
            undefined
        );

      if (hasExtraFields) {
        const existingProfile =
          await repo.profiles.findByUserId(
            user.id
          );

        const existingPrefs =
          (existingProfile &&
            existingProfile.preferences) ||
          {};

        data.preferences = {
          ...existingPrefs,
          ...(data.preferences || {}),
        };

        for (const f of extraFields) {
          if (
            req.body[f] !==
            undefined
          ) {
            data.preferences[f] =
              req.body[f];
          }
        }
      }

      const profile =
        await repo.profiles.upsert(
          user.id,
          data
        );

      return res.json(profile);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/profile/resume",
  authRequired,
  uploadResume.single("resume"),
  async (req, res, next) => {
    try {
      const requestedId =
        req.params.id === "me"
          ? req.user.sub
          : req.params.id;

      const user =
        await repo.users.findById(
          requestedId
        );

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      // Only owner or admin
      const isOwner =
        req.user.sub === user.id ||
        (user.clerk_id &&
          (req.user.clerk_id ===
            user.clerk_id ||
            req.user.sub ===
              user.clerk_id));

      if (
        !isOwner &&
        req.user.role !== "admin"
      ) {
        return res.status(403).json({
          error:
            "Cannot update another user's resume.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error:
            "Please select a resume.",
        });
      }

      const existingProfile =
        await repo.profiles.findByUserId(
          user.id
        );

      const resume = {
        file_name:
          req.file.originalname,
        stored_name:
          req.file.filename,
        file_type:
          req.file.mimetype,
        file_size:
          req.file.size,
        url:
          `/uploads/resumes/${req.file.filename}`,
      };

      const profile =
        await repo.profiles.upsert(
          user.id,
          {
            resume,
          }
        );

      return res.json({
        message:
          existingProfile?.resume
            ? "Resume replaced successfully."
            : "Resume uploaded successfully.",
        resume: profile.resume,
        profile,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/users/{id}/avatar:
 *   post:
 *     tags: [Users]
 *     summary: Upload and set user profile picture
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  "/:id/avatar",
  authRequired,
  uploadAvatar.single("avatar"),
  async (req, res, next) => {
    try {
      const requestedId =
        req.params.id === "me"
          ? req.user.sub
          : req.params.id;

      const user =
        await repo.users.findById(
          requestedId
        );

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      const isOwner =
        req.user.sub === user.id ||
        (user.clerk_id &&
          (req.user.clerk_id ===
            user.clerk_id ||
            req.user.sub ===
              user.clerk_id));

      if (
        !isOwner &&
        req.user.role !== "admin"
      ) {
        return res.status(403).json({
          error:
            "Cannot update another user's avatar.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error:
            "Please select an image file.",
        });
      }

      const avatarUrl =
        `/uploads/avatars/${req.file.filename}`;

      const existingProfile =
        await repo.profiles.findByUserId(
          user.id
        );

      const existingPrefs =
        (existingProfile &&
          existingProfile.preferences) ||
        {};

      const updatedProfile =
        await repo.profiles.upsert(
          user.id,
          {
            preferences: {
              ...existingPrefs,
              avatar_url:
                avatarUrl,
            },
          }
        );

      return res.json({
        success: true,
        message:
          "Profile picture updated successfully.",
        avatar_url:
          avatarUrl,
        profile:
          updatedProfile,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/users/{id}/avatar:
 *   delete:
 *     tags: [Users]
 *     summary: Remove user profile picture
 *     security: [{ bearerAuth: [] }]
 */
router.delete(
  "/:id/avatar",
  authRequired,
  async (req, res, next) => {
    try {
      const requestedId =
        req.params.id === "me"
          ? req.user.sub
          : req.params.id;

      const user =
        await repo.users.findById(
          requestedId
        );

      if (!user) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      const isOwner =
        req.user.sub === user.id ||
        (user.clerk_id &&
          (req.user.clerk_id ===
            user.clerk_id ||
            req.user.sub ===
              user.clerk_id));

      if (
        !isOwner &&
        req.user.role !== "admin"
      ) {
        return res.status(403).json({
          error:
            "Cannot update another user's avatar.",
        });
      }

      const existingProfile =
        await repo.profiles.findByUserId(
          user.id
        );

      const existingPrefs =
        (existingProfile &&
          existingProfile.preferences) ||
        {};

      const updatedPrefs = {
        ...existingPrefs,
      };

      delete updatedPrefs.avatar_url;

      const updatedProfile =
        await repo.profiles.upsert(
          user.id,
          {
            preferences:
              updatedPrefs,
          }
        );

      return res.json({
        success: true,
        message:
          "Profile picture removed successfully.",
        avatar_url: null,
        profile:
          updatedProfile,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/users/students/candidates:
 *   get:
 *     tags: [Users]
 *     summary: List students for employer candidate search
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  "/students/candidates",
  authRequired,
  roleRequired(
    "educator",
    "employer",
    "admin"
  ),
  async (req, res, next) => {
    try {
      const students =
        await repo.users.list({
          role: "student",
          status: "active",
        });

      return res.json(
        students.map(
          (student) =>
            sanitizeUser(student)
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;