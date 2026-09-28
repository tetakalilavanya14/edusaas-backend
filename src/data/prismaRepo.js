const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");

const prisma = new PrismaClient();

const userInclude = {
  role: {
    include: {
      permissions: {
        include: {
          permission: true,
        },
      },
    },
  },
  domainRole: true,
  profile: true,
};


const { getSubscriptionStatus } = require("../config/subscriptionStatus");


const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// Buckets records into the last 4 rolling 7-day windows (Week 1 = oldest, Week 4 = most
// recent, i.e. this week), summing valueFn(record) into whichever window record[dateField]
// falls in. Records older than 28 days are dropped.
function weeklyBuckets(records, dateField, valueFn) {
  const buckets = [0, 0, 0, 0];
  const now = Date.now();
  const msDay = 24 * 60 * 60 * 1000;
  for (const r of records) {
    const ts = new Date(r[dateField]).getTime();
    if (Number.isNaN(ts)) continue;
    const daysAgo = Math.floor((now - ts) / msDay);
    if (daysAgo < 0 || daysAgo >= 28) continue;
    const idx = 3 - Math.floor(daysAgo / 7);
    if (idx >= 0 && idx < 4) buckets[idx] += valueFn(r);
  }
  return buckets.map((value, i) => ({ week: `Week ${i + 1}`, value: Math.round(value * 10) / 10 }));
}

function learningProgressByEnrollment(
  records,
  enrollments,
  dateField,
  valueFn
) {
  if (!enrollments.length) return [];

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MAX_DAYS = 28;

  // Student's first enrollment date
  const enrollmentDate = new Date(
    Math.min(
      ...enrollments.map((e) => new Date(e.enrolled_at).getTime())
    )
  );
  enrollmentDate.setHours(0, 0, 0, 0);

  // Today's date
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Days since enrollment
  const elapsedDays = Math.min(
    MAX_DAYS,
    Math.max(
      0,
      Math.floor(
        (today.getTime() - enrollmentDate.getTime()) / MS_PER_DAY
      )
    )
  );

  // Always build 29 points (Day0 -> Day28)
  const dailyProgress = Array(MAX_DAYS + 1).fill(null);

  // Starting point
  dailyProgress[0] = 0;

  // Count completed lessons on each day
  for (const record of records) {
    if (!record[dateField]) continue;

    const completedDate = new Date(record[dateField]);
    completedDate.setHours(0, 0, 0, 0);

    const dayIndex = Math.floor(
      (completedDate.getTime() - enrollmentDate.getTime()) /
        MS_PER_DAY
    );

    if (dayIndex < 0 || dayIndex > elapsedDays) continue;

    if (dailyProgress[dayIndex] === null) {
      dailyProgress[dayIndex] = 0;
    }

    dailyProgress[dayIndex] += valueFn(record);
  }

  // Convert to cumulative values
  for (let day = 1; day <= elapsedDays; day++) {
    if (dailyProgress[day] === null) {
      dailyProgress[day] = dailyProgress[day - 1];
    } else {
      dailyProgress[day] += dailyProgress[day - 1];
    }
  }

  // Build chart data
  return dailyProgress.map((value, day) => {
    let week = "";

    if (day === 0) week = "Week 0";
    else if (day === 7) week = "Week 1";
    else if (day === 14) week = "Week 2";
    else if (day === 21) week = "Week 3";
    else if (day === 28) week = "Week 4";

    return {
      day,
      week,
      value: day <= elapsedDays ? value : null,
    };
  });
}

/**
 * A higher-order function to wrap Prisma queries for safe error handling.
 * It catches Prisma's "Record Not Found" error (P2025) and returns null,
 * while re-throwing any other errors.
 * @param {Promise<T>} query - The Prisma query to execute.
 * @returns {Promise<T|null>}
 * @template T
 */
  const safeQuery = async (query) => {
    try {
      return await query;
    } catch (e) {
      if (e.code === "P2025") return null;
      throw e;
    }
  };

  // User rows are always fetched with role + role.permissions included so we can
  // expose `role` (name) and `permissions[]` to callers.


  const mapUser = (u) =>
      u && {
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        clerk_id: u.clerk_id,
        role_id: u.role_id,
        role: u.role?.name || null,

        domain_role_id: u.domain_role_id,
        domain_role: u.domainRole?.domain_name || null,

        permissions:
          u.role?.permissions?.map((rp) => rp.permission.name) || [],

        password_hash: u.password_hash,
        status: u.status,
        last_login: iso(u.last_login),
        created_at: iso(u.created_at),
      };

  const communityPostInclude = {
    users: {
      include: {
        role: {
          select: {
            name: true,
          }
        }
      },
    },

    community_post_tags: {
      include: {
        community_tags: {
          select: {
            id: true,
            name: true,
            slug: true,
          }
        }
      },
    },
  }

  function mapCommunityPost(post) {
  if (!post) return null;

  return {
    id: post.id,
    author_id: post.author_id,

    title: post.title,
    content: post.content,

    post_type: post.post_type,
    status: post.status,
    visibility: post.visibility,

    media_url: post.media_url,
    metadata: post.metadata,

    comments_count: post.comments_count,
    reactions_count: post.reactions_count,

    created_at: iso(post.created_at),
    updated_at: iso(post.updated_at),
    deleted_at: iso(post.deleted_at),

    author: {
      id: post.users.id,
      name: post.users.name,
      email: post.users.email,
      role: post.users.role.name,
    },

    tags:
      post.community_post_tags?.map(
        (tag) => ({
          id: tag.community_tags.id,
          name: tag.community_tags.name,
          slug: tag.community_tags.slug,
        })
      ) ?? [],
  };
  }



const mapAssessment = (a) => a && { ...a, date_taken: iso(a.date_taken) };
const mapEnrollment = (e) => e && { ...e, enrolled_at: iso(e.enrolled_at) };
const mapJob = (j) => j && { ...j, created_at: iso(j.created_at) };
const mapApp = (a) => a && { ...a, applied_at: iso(a.applied_at) };
const mapNotif = (n) => n && { ...n, created_at: iso(n.created_at) };
const mapCourse = (c) => c && { ...c, created_at: iso(c.created_at) };
const mapReportRow = (r) =>
  r && { ...r, generated_at: iso(r.generated_at), exported_at: iso(r.exported_at) };
const mapGap = (r) => r && { ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
const mapSub = (s) => s && { ...s, start_date: iso(s.start_date), end_date: iso(s.end_date) };
const mapLesson = (l) => l && { ...l, created_at: iso(l.created_at) };
const mapAssignment = (a) => a && { ...a, created_at: iso(a.created_at) };
const mapProgress = (p) => p && { ...p, updated_at: iso(p.updated_at) };
const mapCert = (c) => c && { ...c, issued_date: iso(c.issued_date) };
const mapAch = (a) => a && { ...a, earned_at: iso(a.earned_at) };
const mapTask = (t) => t && { ...t, due_date: iso(t.due_date), created_at: iso(t.created_at) };
const mapRec = (r) => r && { ...r, created_at: iso(r.created_at) };
const mapAnn = (a) =>
  a && {
    ...a,
    scheduled_at: iso(a.scheduled_at),
    created_at: iso(a.created_at),
    educator: a.educator
      ? {
          id: a.educator.id,
          name: a.educator.name,
          email: a.educator.email,
        }
      : undefined,
  };


module.exports = {
  prisma,

   //Platform health
   health: {
    database: async () => {
      const startedAt = Date.now();

      try {
        await prisma.$queryRaw`SELECT 1`;

        return {
          status: "ok",
          responseTimeMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          status: "error",
          responseTimeMs: Date.now() - startedAt,
          error: error.message,
        };
      }
    },
  },

  domainRoles: {
    list: async () => prisma.domainRole.findMany({ orderBy: { domain_name: "asc" } }),
  },

  connections: {
    sendRequest: async (requesterId, receiverId) => {
      return await prisma.connection.upsert({
        where: { requesterId_receiverId: { requesterId, receiverId } },
        update: { status: "pending" },
        create: { requesterId, receiverId, status: "pending" }
      });
    },
    acceptRequest: async (connectionId, receiverId) => {
      return await prisma.connection.updateMany({
        where: { id: connectionId, receiverId, status: "pending" },
        data: { status: "accepted" }
      });
    },
    rejectRequest: async (connectionId, receiverId) => {
      return await prisma.connection.updateMany({
        where: { id: connectionId, receiverId, status: "pending" },
        data: { status: "rejected" }
      });
    },
    getConnections: async (userId) => {
      // Get all accepted connections where user is either requester or receiver
      return await prisma.connection.findMany({
        where: {
          status: "accepted",
          OR: [{ requesterId: userId }, { receiverId: userId }]
        },
        include: {
          requester: { select: { id: true, name: true, email: true, role: true } },
          receiver: { select: { id: true, name: true, email: true, role: true } }
        }
      });
    },
    getPendingRequests: async (userId) => {
      return await prisma.connection.findMany({
        where: { receiverId: userId, status: "pending" },
        include: {
          requester: { select: { id: true, name: true, email: true, role: true } }
        }
      });
    },
    removeConnection: async (connectionId, userId) => {
      // Find the connection first
      const conn = await prisma.connection.findFirst({
        where: {
          id: connectionId,
          OR: [{ requesterId: userId }, { receiverId: userId }]
        }
      });

      if (!conn) return { count: 0 };

      // Delete the notification if it was a pending request
      if (conn.status === 'pending') {
        // The requester is cancelling, or receiver rejecting
        // We delete the notification for the receiver
        const requester = await prisma.user.findUnique({ where: { id: conn.requesterId }});
        if (requester) {
          await prisma.notification.deleteMany({
            where: {
              user_id: conn.receiverId,
              type: "connection_request",
              message: { startsWith: requester.name || 'Someone' }
            }
          });
        }
      }

      return await prisma.connection.deleteMany({
        where: { id: connectionId }
      });
    }
  },

  users: {
    searchByUsername: async (username, excludeId = null) => {
      const whereClause = { username: { contains: username, mode: "insensitive" } };
      if (excludeId) whereClause.id = { not: excludeId };

      const users = await prisma.user.findMany({
        where: whereClause,
        select: { id: true, name: true, username: true, email: true, role: true },
        take: 10
      });

      if (!excludeId || users.length === 0) return users;

      // Fetch connections between excludeId and these users
      const userIds = users.map(u => u.id);
      const connections = await prisma.connection.findMany({
        where: {
          OR: [
            { requesterId: excludeId, receiverId: { in: userIds } },
            { requesterId: { in: userIds }, receiverId: excludeId }
          ]
        }
      });

      return users.map(u => {
        const conn = connections.find(c => c.requesterId === u.id || c.receiverId === u.id);
        if (conn) {
          let status = conn.status;
          if (status === 'pending') {
            status = conn.requesterId === excludeId ? 'pending_sent' : 'pending_received';
          }
          return { ...u, connection_status: status, connection_id: conn.id };
        }
        return u;
      });
    },
    findById: async (id) => {
      if (!id) return null;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!isUUID) {
        return mapUser(await prisma.user.findUnique({ where: { clerk_id: id }, include: userInclude }));
      }
      return mapUser(await prisma.user.findUnique({ where: { id }, include: userInclude }));
    },
    findByEmail: async (email) =>
      mapUser(await prisma.user.findUnique({ where: { email }, include: userInclude })),


    findByClerkId: async (clerkId) =>
  mapUser(
    await prisma.user.findFirst({
      where: { clerk_id: clerkId },
      include: userInclude,
    })
  ),

    deleteByClerkId: async (clerk_id) =>
      await prisma.user.delete({ where: { clerk_id } }),
    list: async (filters = {}) => {
      const where = {};
      if (filters.role) where.role = { name: filters.role };
      if (filters.status) where.status = filters.status;
      if (filters.q) {
        where.OR = [
          { name: { contains: filters.q, mode: "insensitive" } },
          { email: { contains: filters.q, mode: "insensitive" } },
        ];
      }
      return (await prisma.user.findMany({
        where, orderBy: { created_at: "desc" }, include: userInclude,
      })).map(mapUser);
    },
    create: async (data) => {
      // Translate `role` (name) ? role_id if needed
      let { role, role_id, permissions, ...rest } = data;
      if (!role_id && role) {
        const r = await prisma.role.findUnique({ where: { name: role } });
        if (!r) throw new Error(`invalid role: ${role}`);
        role_id = r.id;
      }
      if (!role_id) throw new Error("role_id or role required");
      return mapUser(await prisma.user.create({
        data: { ...rest, role_id },
        include: userInclude,
      }));
    },
    update: async (id, data) => {
      let { role, role_id, permissions, username, ...rest } = data;
      if (!role_id && role) {
        const r = await prisma.role.findUnique({ where: { name: role } });
        if (!r) throw new Error(`invalid role: ${role}`);
        role_id = r.id;
      }
      const patch = role_id ? { ...rest, role_id } : rest;
      return mapUser(await safeQuery(prisma.user.update({
        where: { id }, data: patch, include: userInclude,
      })));
    },
    remove: async (id) => {
      try { await prisma.user.delete({ where: { id } }); return true; }
      catch (e) { if (e.code === "P2025") return false; throw e; }
    },
    touchLogin: async (id) => {
      try { await prisma.user.update({ where: { id }, data: { last_login: new Date() } }); }
      catch (_) {}
    },
    async updatePassword(userId, password_hash) {
      return prisma.user.update({
        where: {
          id: userId,
        },
        data: {
          password_hash,
        },
      });
    },
  },

  authOtps: {
  async create(data) {
    return prisma.authOtp.create({ data });
  },

  async findByUserId(userId) {
    return prisma.authOtp.findUnique({
      where: {
        user_id: userId,
      },
    });
  },

  async deleteByUserId(userId) {
    return prisma.authOtp.deleteMany({
      where: {
        user_id: userId,
      },
    });
  },

  verify: async (id) => {
    return prisma.authOtp.update({
      where: {
        id,
      },
      data: {
        verified_at: new Date(),
      },
    });
  },
  },

  refreshTokens: {
    create: async (data) => {
      return prisma.refreshToken.create({ data });
    },

    findById: async (id) => {
      return prisma.refreshToken.findUnique({
        where: { id },
      });
    },

    findByUserId: async (userId) => {
      return prisma.refreshToken.findMany({
        where: { user_id: userId },
      });
    },

    delete: async (id) => {
      return prisma.refreshToken.delete({
        where: { id },
      });
    },

    deleteByUserId: async (userId) => {
      return prisma.refreshToken.deleteMany({
        where: { user_id: userId },
      });
    },
  },

  roles: {
    list: async () => prisma.role.findMany({ orderBy: { name: "asc" } }),
    findByName: async (name) => prisma.role.findUnique({ where: { name } }),
    findById: async (id) => prisma.role.findUnique({ where: { id } }),
    permissionsForRoleId: async (roleId) => {
      const links = await prisma.rolePermission.findMany({
        where: { role_id: roleId }, include: { permission: true },
      });
      return links.map((l) => l.permission.name);
    },
  },

  permissions: {
    list: async () => prisma.permission.findMany({ orderBy: { name: "asc" } }),
  },

  profiles: {
    findByUserId: async (user_id) =>
      prisma.profile.findUnique({
        where: { user_id },
      }),

    upsert: async (user_id, data) => {
      return prisma.profile.upsert({
        where: { user_id },
        update: data,
        create: {
          ...data,
          user_id,
        },
      });
    },

    markInitialAssessmentCompleted: async (tx, user_id) =>
      tx.profile.update({
        where: {
          user_id,
        },
        data: {
          initial_assessment_completed: true,
        },

      }),
  },

  assessments: {
    create: async (data) => {
      const assessment = await prisma.$transaction(async (tx) => {
        const createdAssessment = await tx.assessment.create({
          data,
        });

        await tx.profile.update({
          where: {
            user_id: data.user_id,
          },
          data: {
            initial_assessment_completed: true,
          },
        });

        return createdAssessment;
      });

      return mapAssessment(assessment);
    },

    findById: async (id) =>
      mapAssessment(
        await prisma.assessment.findUnique({
          where: { id },
        })
      ),

    listByUser: async (user_id) =>
      (
        await prisma.assessment.findMany({
          where: { user_id },
        })
      ).map(mapAssessment),

    findInitialByUser: (userId) =>
      prisma.assessment.findFirst({
        where: {
          user_id: userId,
          is_initial: true,
        },
      }),

    createInitial: async (data) => {
    const assessment = await prisma.$transaction(async (tx) => {
      const createdAssessment = await tx.assessment.create({
        data,
      });

      await tx.profile.update({
        where: {
          user_id: data.user_id,
        },
        data: {
          initial_assessment_completed: true,
        },
      });

      return createdAssessment;
    });

    return mapAssessment(assessment);
    },
  },

  gapReports: {
    findByUserId: async (user_id) =>
      mapGap(await prisma.gapReport.findFirst({ where: { user_id } })),

    upsert: async (user_id, data) => {
      const existing = await prisma.gapReport.findFirst({
        where: { user_id },
      });

      if (existing) {
        return mapGap(
          await prisma.gapReport.update({
            where: { id: existing.id },
            data,
          })
        );
      }

      return mapGap(
        await prisma.gapReport.create({
          data: {
            ...data,
            user_id,
            readiness_score: data.readiness_score ?? 0,
          },
        })
      );
    },
  },

  courses: {
    list: async (filters = {}) => {
      const where = {};
      if (filters.status) where.status = filters.status;
      if (filters.educator_id) where.educator_id = filters.educator_id;
      if (filters.category) where.category = filters.category;
      if (filters.difficulty) where.difficulty = filters.difficulty;
      if (filters.search) {
        where.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } }
        ];
      }
      const rawCourses = await prisma.course.findMany({
        where,
        include: {
          courseRatings: {
            select: { rating: true },
          },
        },
        orderBy: { created_at: "desc" },
      });
      return rawCourses.map((c) => {
        const ratings = c.courseRatings || [];
        const count = ratings.length;
        const avg =
          count > 0
            ? Math.round(
                (ratings.reduce((sum, r) => sum + r.rating, 0) / count) * 10
              ) / 10
            : null;
        const mapped = mapCourse(c);
        delete mapped.courseRatings;
        return {
          ...mapped,
          rating: avg,
          rating_count: count,
          avgRating: avg,
        };
      });
    },
    findById: async (id) => {
      const c = await prisma.course.findUnique({
        where: { id },
        include: {
          courseRatings: {
            select: { rating: true },
          },
        },
      });
      if (!c) return null;
      const ratings = c.courseRatings || [];
      const count = ratings.length;
      const avg =
        count > 0
          ? Math.round(
              (ratings.reduce((sum, r) => sum + r.rating, 0) / count) * 10
            ) / 10
          : null;
      const mapped = mapCourse(c);
      delete mapped.courseRatings;
      return {
        ...mapped,
        rating: avg,
        rating_count: count,
        avgRating: avg,
      };
    },
    create: async (data) => mapCourse(await prisma.course.create({ data })),
    update: async (id, data) => {
      return mapCourse(await safeQuery(prisma.course.update({ where: { id }, data })));
    },
    remove: async (id) => !!(await safeQuery(prisma.course.delete({ where: { id } }))),
    enrollmentCount: async (id) => prisma.enrollment.count({ where: { course_id: id } }),
  },

  courseRatings: {
    upsert: async ({ user_id, course_id, rating, review }) => {
      return await prisma.courseRating.upsert({
        where: {
          user_id_course_id: { user_id, course_id },
        },
        create: {
          user_id,
          course_id,
          rating: Number(rating),
          review: review !== undefined && review !== null ? String(review).trim() : null,
        },
        update: {
          rating: Number(rating),
          review: review !== undefined && review !== null ? String(review).trim() : null,
          updated_at: new Date(),
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              profile: {
                select: { preferences: true },
              },
            },
          },
        },
      });
    },

    getForUser: async (user_id, course_id) => {
      return await prisma.courseRating.findUnique({
        where: {
          user_id_course_id: { user_id, course_id },
        },
      });
    },

    listByCourse: async (course_id) => {
      const ratings = await prisma.courseRating.findMany({
        where: { course_id },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              profile: {
                select: { preferences: true },
              },
            },
          },
        },
        orderBy: { created_at: "desc" },
      });

      const count = ratings.length;
      const avg =
        count > 0
          ? Math.round(
              (ratings.reduce((sum, r) => sum + r.rating, 0) / count) * 10
            ) / 10
          : 0;

      const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      ratings.forEach((r) => {
        const star = Math.min(5, Math.max(1, Math.round(r.rating)));
        distribution[star] = (distribution[star] || 0) + 1;
      });

      return {
        course_id,
        average_rating: avg,
        total_reviews: count,
        distribution,
        reviews: ratings.map((r) => ({
          id: r.id,
          user_id: r.user_id,
          course_id: r.course_id,
          rating: r.rating,
          review: r.review,
          created_at: iso(r.created_at),
          user_name: r.user?.name || r.user?.username || "Student",
          avatar_url: r.user?.profile?.preferences?.avatar_url || null,
        })),
      };
    },

    listByEducator: async (educator_id) => {
      const courses = await prisma.course.findMany({
        where: { educator_id },
        select: { id: true, title: true, category: true, difficulty: true, thumbnail_url: true },
      });

      if (courses.length === 0) {
        return {
          total_reviews: 0,
          average_rating: 0,
          course_breakdown: [],
          recent_reviews: [],
        };
      }

      const courseMap = {};
      courses.forEach((c) => { courseMap[c.id] = c; });
      const courseIds = courses.map((c) => c.id);

      const ratings = await prisma.courseRating.findMany({
        where: { course_id: { in: courseIds } },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              profile: {
                select: { preferences: true },
              },
            },
          },
        },
        orderBy: { created_at: "desc" },
      });

      const totalReviews = ratings.length;
      const avgRating =
        totalReviews > 0
          ? Math.round(
              (ratings.reduce((sum, r) => sum + r.rating, 0) / totalReviews) * 10
            ) / 10
          : 0;

      const perCourse = {};
      courses.forEach((c) => {
        perCourse[c.id] = {
          course_id: c.id,
          title: c.title,
          category: c.category,
          thumbnail_url: c.thumbnail_url,
          reviews_count: 0,
          total_rating: 0,
          average_rating: 0,
          reviews: [],
        };
      });

      ratings.forEach((r) => {
        if (perCourse[r.course_id]) {
          perCourse[r.course_id].reviews_count += 1;
          perCourse[r.course_id].total_rating += r.rating;
          perCourse[r.course_id].reviews.push({
            id: r.id,
            user_id: r.user_id,
            rating: r.rating,
            review: r.review,
            created_at: iso(r.created_at),
            user_name: r.user?.name || r.user?.username || "Student",
            avatar_url: r.user?.profile?.preferences?.avatar_url || null,
          });
        }
      });

      const course_breakdown = Object.values(perCourse).map((cp) => ({
        ...cp,
        average_rating:
          cp.reviews_count > 0
            ? Math.round((cp.total_rating / cp.reviews_count) * 10) / 10
            : 0,
      }));

      const recent_reviews = ratings.slice(0, 20).map((r) => ({
        id: r.id,
        user_id: r.user_id,
        course_id: r.course_id,
        course_title: courseMap[r.course_id]?.title || "Course",
        rating: r.rating,
        review: r.review,
        created_at: iso(r.created_at),
        user_name: r.user?.name || r.user?.username || "Student",
        avatar_url: r.user?.profile?.preferences?.avatar_url || null,
      }));

      return {
        total_reviews: totalReviews,
        average_rating: avgRating,
        course_breakdown,
        recent_reviews,
      };
    },
  },

  enrollments: {
    findOne: async (user_id, course_id) =>
      mapEnrollment(await prisma.enrollment.findUnique({
        where: { user_id_course_id: { user_id, course_id } },
      })),
    create: async (data) => mapEnrollment(await prisma.enrollment.create({ data })),
    update: async (user_id, course_id, data) =>
      mapEnrollment(await prisma.enrollment.update({
        where: { user_id_course_id: { user_id, course_id } },
        data
      })),
    listByUser: async (user_id) =>
      (
        await prisma.enrollment.findMany({
          where: { user_id },
          include: { course: true },
        })
      ).map(mapEnrollment),
    listByCourse: async (course_id) =>
      (
        await prisma.enrollment.findMany({
          where: { course_id },
          include: { user: true },
        })
      ).map(mapEnrollment),
  },

  jobs: {
    list: async () => {
      try {
        const rows = await prisma.$queryRawUnsafe(`
          SELECT * FROM education.jobs ORDER BY created_at DESC
        `);
        return rows.map(mapJob);
      } catch {
        return (await prisma.job.findMany({ orderBy: { created_at: "desc" } })).map(mapJob);
      }
    },
    findById: async (id) => {
      if (!id) return null;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!isUUID) return null;
      try {
        const rows = await prisma.$queryRawUnsafe(`
          SELECT * FROM education.jobs WHERE id = $1::uuid
        `, id);
        return mapJob(rows[0] || null);
      } catch {
        return mapJob(await prisma.job.findUnique({ where: { id } }));
      }
    },
    create: async (data) => {
      try {
        return mapJob(await prisma.job.create({ data }));
      } catch (err) {
        if (err.message && err.message.includes("Unknown argument")) {
          const cols = [];
          const placeholders = [];
          const values = [];
          let idx = 1;

          for (const [k, v] of Object.entries(data)) {
            cols.push(`"${k}"`);
            if (k === 'employer_id' || k === 'domain_role_id') {
              placeholders.push(`$${idx}::uuid`);
            } else if (k === 'required_skills' || k === 'preferred_skills' || k === 'eligible_branches') {
              placeholders.push(`$${idx}::text[]`);
            } else if (k === 'require_video') {
              placeholders.push(`$${idx}::boolean`);
            } else if (k === 'video_max_duration') {
              placeholders.push(`$${idx}::integer`);
            } else {
              placeholders.push(`$${idx}`);
            }
            values.push(v);
            idx++;
          }

          const sql = `
            INSERT INTO education.jobs (${cols.join(', ')})
            VALUES (${placeholders.join(', ')})
            RETURNING *
          `;
          const rows = await prisma.$queryRawUnsafe(sql, ...values);
          return mapJob(rows[0]);
        }
        throw err;
      }
    },
    update: async (id, data) => {
      try {
        return mapJob(await safeQuery(prisma.job.update({ where: { id }, data })));
      } catch (err) {
        if (err.message && err.message.includes("Unknown argument")) {
          const setClauses = [];
          const values = [];
          let idx = 1;

          for (const [k, v] of Object.entries(data)) {
            if (k === 'id') continue;
            let placeholder = `$${idx}`;
            if (k === 'employer_id' || k === 'domain_role_id') {
              placeholder += '::uuid';
            } else if (k === 'required_skills' || k === 'preferred_skills' || k === 'eligible_branches') {
              placeholder += '::text[]';
            } else if (k === 'require_video') {
              placeholder += '::boolean';
            } else if (k === 'video_max_duration') {
              placeholder += '::integer';
            }
            setClauses.push(`"${k}" = ${placeholder}`);
            values.push(v);
            idx++;
          }

          values.push(id);
          const sql = `
            UPDATE education.jobs
            SET ${setClauses.join(', ')}
            WHERE id = $${idx}::uuid
            RETURNING *
          `;
          const rows = await prisma.$queryRawUnsafe(sql, ...values);
          return mapJob(rows[0]);
        }
        throw err;
      }
    },
    remove: async (id) => !!(await safeQuery(prisma.job.delete({ where: { id } }))),
    listByEmployer: async (employer_id) => {
      if (!employer_id) return [];
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employer_id);
      let targetId = employer_id;
      if (!isUUID) {
        const employer = await prisma.user.findUnique({
          where: { clerk_id: employer_id },
          select: { id: true },
        });
        if (!employer) return [];
        targetId = employer.id;
      }
      try {
        const rows = await prisma.$queryRawUnsafe(`
          SELECT * FROM education.jobs WHERE employer_id = $1::uuid ORDER BY created_at DESC
        `, targetId);
        return rows.map(mapJob);
      } catch {
        return (await prisma.job.findMany({
          where: { employer_id: targetId },
          orderBy: { created_at: "desc" },
        })).map(mapJob);
      }
    },
  },

applications: {
  findOne: async (job_id, student_id) =>
    mapApp(
      await prisma.application.findUnique({
        where: { job_id_student_id: { job_id, student_id } },
      })
    ),

  findById: async (id) =>
    mapApp(
      await safeQuery(
        prisma.application.findUnique({
          where: { id },
        })
      )
    ),

  create: async (data) =>
    mapApp(await prisma.application.create({ data })),

  update: async (id, data) =>
    mapApp(
      await safeQuery(
        prisma.application.update({
          where: { id },
          data,
        })
      )
    ),

  listByJob: async (job_id) =>
    (await prisma.application.findMany({ where: { job_id } })).map(mapApp),

  listByJobWithStudent: async (job_id) =>
    (
      await prisma.application.findMany({
        where: { job_id },
        include: {
          student: true,
        },
        orderBy: {
          applied_at: "desc",
        },
      })
    ).map((application) => ({
      ...mapApp(application),
      student_name: application.student?.name || null,
      student_email: application.student?.email || null,
    })),

  listByStudent: async (student_id) => {
    if (!student_id) return [];

    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        student_id
      );

    let targetId = student_id;

    if (!isUUID) {
      const student = await prisma.user.findUnique({
        where: { clerk_id: student_id },
        select: { id: true },
      });

      if (!student) return [];

      targetId = student.id;
    }

    return (
      await prisma.application.findMany({
        where: {
          student_id: targetId,
        },
        orderBy: {
          applied_at: "desc",
        },
      })
    ).map(mapApp);
  },
},

interviews: {
  findById: async (id) =>
    safeQuery(
      prisma.interview.findUnique({
        where: { id },
      })
    ),

  findByApplication: async (application_id) =>
    safeQuery(
      prisma.interview.findFirst({
        where: { application_id },
        orderBy: { scheduled_at: "desc" },
      })
    ),

  create: async (data) =>
    safeQuery(
      prisma.interview.create({
        data,
      })
    ),

  update: async (id, data) =>
    safeQuery(
      prisma.interview.update({
        where: { id },
        data,
      })
    ),

  remove: async (id) =>
    !!(
      await safeQuery(
        prisma.interview.delete({
          where: { id },
        })
      )
    ),
},

  notifications: {
  listByUser: async (user_id, limit = 50) =>
    (
      await prisma.notification.findMany({
        where: {
          user_id,
          OR: [
            { expires_at: null },
            { expires_at: { gt: new Date() } },
          ],
        },
        orderBy: {
          created_at: "desc",
        },
        take: limit || 50,
      })
    ).map(mapNotif),

  create: async (data) =>
    mapNotif(
      await prisma.notification.create({
        data,
      })
    ),

  markRead: async (id, user_id) => {
    const notification = await prisma.notification.findFirst({
      where: { id, user_id },
    });

    if (!notification) return null;

    return mapNotif(
      await prisma.notification.update({
        where: { id },
        data: { read_status: true },
      })
    );
  },

  markAllRead: async (user_id) => {
    return prisma.notification.updateMany({
      where: { user_id, read_status: false },
      data: { read_status: true },
    });
  },
},

 subscriptions: {
  findByUserId: async (user_id) => {
  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });

  if (!subscription) {
    return null;
  }

  return {
    ...mapSub(subscription),
    status: getSubscriptionStatus(
      subscription.start_date,
      subscription.end_date
    ),
  };
},
  upsert: async (user_id, data) => {
    const existing = await prisma.subscription.findFirst({
      where: { user_id },
    });

    if (existing) {
      return mapSub(
        await prisma.subscription.update({
          where: { id: existing.id },
          data,
        })
      );
    }

    return mapSub(
      await prisma.subscription.create({
        data: {
          ...data,
          user_id,
        },
      })
    );
  },

  // Admin: read all subscriptions
  listAll: async () => {
    const rows = await prisma.subscription.findMany({
      orderBy: { start_date: "desc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    const now = new Date();

    return rows.map((row) => {
      const start = new Date(row.start_date);
      const end = new Date(row.end_date);

      const status = getSubscriptionStatus(
  row.start_date,
  row.end_date
);

      return {
        ...mapSub(row),
        status,
        user: row.user,
      };
    });
  },

  // Admin: subscription statistics
  summary: async () => {
    const rows = await prisma.subscription.findMany({
      select: {
        start_date: true,
        end_date: true,
        plan_type: true,
      },
    });

    const now = new Date();

    let active = 0;
    let expired = 0;
    let expiringSoon = 0;
    let pending = 0;

    const plans = {
      free: 0,
      basic: 0,
      pro: 0,
      enterprise: 0,
    };

    for (const row of rows) {
      const start = new Date(row.start_date);
      const end = new Date(row.end_date);

     const status = getSubscriptionStatus(
  row.start_date,
  row.end_date
);

if (status === "Expired") {
  expired++;
} else if (status === "Expiring Soon") {
  expiringSoon++;
} else if (status === "Active") {
  active++;
} else {
  pending++;
}

      const plan = String(row.plan_type || "").toLowerCase();

      if (Object.prototype.hasOwnProperty.call(plans, plan)) {
        plans[plan]++;
      }
    }

    return {
      total: rows.length,
      active,
      expiringSoon,
      expired,
      pending,
      plans,
    };
  },

    // Admin: change subscription plan
  updatePlan: async (id, plan_type) => {
    const subscription = await prisma.subscription.findUnique({
      where: { id },
    });

    if (!subscription) {
      throw new Error("Subscription not found.");
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: { plan_type },
    });

    return {
      ...mapSub(updated),
      status: getSubscriptionStatus(
        updated.start_date,
        updated.end_date
      ),
    };
  },

  // Admin: extend subscription
  extend: async (id, months) => {
    const subscription = await prisma.subscription.findUnique({
      where: { id },
    });

    if (!subscription) {
      throw new Error("Subscription not found.");
    }

    const currentEnd = new Date(subscription.end_date);
    const now = new Date();

    // If already expired, extension starts from today.
    const baseDate = currentEnd > now ? currentEnd : now;

    const newEnd = new Date(baseDate);
    newEnd.setMonth(newEnd.getMonth() + months);

    const updated = await prisma.subscription.update({
      where: { id },
      data: { end_date: newEnd },
    });

    return {
      ...mapSub(updated),
      status: getSubscriptionStatus(
        updated.start_date,
        updated.end_date
      ),
    };
  },
},

  reports: {

 generate: async (type = "Course Performance") => {
      if (type !== "Course Performance") {
        throw new Error(`Unsupported report type: ${type}`);
      }

      const now = new Date();
      const startOfMonth = new Date(
        now.getFullYear(),
        now.getMonth(),
        1
      );

      const [
        totalCourses,
        activeCourses,
        newCoursesThisMonth,
        totalEnrollments,
        completedEnrollments,
        activeEnrollments,
        droppedEnrollments,
      ] = await Promise.all([
        prisma.course.count(),

        prisma.course.count({
          where: { status: "active" },
        }),

        prisma.course.count({
          where: {
            created_at: {
              gte: startOfMonth,
            },
          },
        }),

        prisma.enrollment.count(),

        prisma.enrollment.count({
          where: {
            status: "completed",
          },
        }),

        prisma.enrollment.count({
          where: {
            status: "active",
          },
        }),

        prisma.enrollment.count({
          where: {
            status: {
              in: ["dropped", "dropout", "failed"],
            },
          },
        }),
      ]);

      const completionRate =
        totalEnrollments === 0
          ? 0
          : Math.round(
              (completedEnrollments / totalEnrollments) * 100
            );

      const activeEnrollmentRate =
        totalEnrollments === 0
          ? 0
          : Math.round(
              (activeEnrollments / totalEnrollments) * 100
            );

      const payload = {
        totalCourses,
        activeCourses,
        newCoursesThisMonth,
        totalEnrollments,
        completedEnrollments,
        activeEnrollments,
        droppedEnrollments,
        completionRate,
        activeEnrollmentRate,
        generatedAt: now.toISOString(),
      };

      const report = await prisma.report.create({
        data: {
          title: "Course Performance Report",
          type: "Course Performance",
          format: "JSON",
          payload,
        },
      });

      return mapReportRow(report);
    },
    list: async () => {
      const rows = await prisma.report.findMany({
        orderBy: { generated_at: "desc" },
        take: 50,
      });

      return rows.map(mapReportRow);
    },

    listExports: async () => {
      const rows = await prisma.report.findMany({
        where: {
          exported_at: {
            not: null,
          },
        },
        orderBy: { exported_at: "desc" },
        take: 50,
      });

      return rows.map(mapReportRow);
    },

    update: async (id, data) => {
      const report = await prisma.report.update({
        where: { id },
        data,
      });

      return mapReportRow(report);
    },
summary: async (userId) => {
  const now = new Date();

  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  );

  const [
    totalReports,
    activeAlerts,

    totalUsers,
    newUsers,
    activeUsers,

    totalEnrollments,
    completedEnrollments,
    droppedEnrollments,

    totalJobs,
    openJobs,

    totalApplications,
    shortlistedApplications,
    selectedApplications,
    rejectedApplications,

    totalAssessments,
    completedAssessments,
  ] = await Promise.all([
    // Reports
    prisma.report.count(),

   // Admin's active/unread notifications
prisma.notification.count({
  where: {
    user_id: userId,
    read_status: false,
    OR: [
      { expires_at: null },
      { expires_at: { gte: now } },
    ],
  },
}),

    // Users
    prisma.user.count(),

    prisma.user.count({
      where: {
        created_at: {
          gte: monthStart,
        },
      },
    }),

    prisma.user.count({
      where: {
        last_login: {
          gte: monthStart,
        },
      },
    }),

    // Learning / Enrollment
    prisma.enrollment.count(),

    prisma.enrollment.count({
      where: {
        status: "completed",
      },
    }),

    prisma.enrollment.count({
      where: {
        status: {
          in: ["dropped", "dropout", "failed"],
        },
      },
    }),

    // Recruitment / Jobs
    prisma.job.count(),

    prisma.job.count({
      where: {
        status: "open",
      },
    }),

    // Recruitment / Applications
    prisma.application.count(),

    prisma.application.count({
      where: {
        status: "shortlisted",
      },
    }),

    prisma.application.count({
      where: {
        status: "selected",
      },
    }),

    prisma.application.count({
      where: {
        status: "rejected",
      },
    }),

    // Assessments
    prisma.assessment.count(),

    prisma.assessment.count({
      where: {
        completed: true,
      },
    }),
  ]);

    const [
    enrollmentsMissingUser,
    enrollmentsMissingCourse,
    applicationsMissingJob,
    applicationsMissingStudent,
  ] = await Promise.all([
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM education.enrollments e
      LEFT JOIN education.users u ON u.id = e.user_id
      WHERE u.id IS NULL
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM education.enrollments e
      LEFT JOIN education.courses c ON c.id = e.course_id
      WHERE c.id IS NULL
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM education.applications a
      LEFT JOIN education.jobs j ON j.id = a.job_id
      WHERE j.id IS NULL
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM education.applications a
      LEFT JOIN education.users u ON u.id = a.student_id
      WHERE u.id IS NULL
    `,
  ]);

  const invalidRelationships =
    enrollmentsMissingUser[0].count +
    enrollmentsMissingCourse[0].count +
    applicationsMissingJob[0].count +
    applicationsMissingStudent[0].count;

  const dataAccuracy =
    invalidRelationships === 0 ? 100 : 0;


const courseEngagement = [];

for (let i = 5; i >= 0; i--) {
  const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
  const nextMonthStart = new Date(
    now.getFullYear(),
    now.getMonth() - i + 1,
    1
  );

  const [monthlyCompleted, monthlyDropped] = await Promise.all([
    prisma.enrollment.count({
      where: {
        enrolled_at: {
          gte: monthStart,
          lt: nextMonthStart,
        },
        status: "completed",
      },
    }),
    prisma.enrollment.count({
      where: {
        enrolled_at: {
          gte: monthStart,
          lt: nextMonthStart,
        },
        status: {
          in: ["dropped", "dropout", "failed"],
        },
      },
    }),
  ]);

  courseEngagement.push({
    month: monthStart.toLocaleString("en-US", {
      month: "short",
    }),
    completions: monthlyCompleted,
    dropouts: monthlyDropped,
  });
}

const completionRate =
  totalEnrollments === 0
    ? 0
    : Math.round((completedEnrollments / totalEnrollments) * 100);

const dropoutRate =
  totalEnrollments === 0
    ? 0
    : Math.round((droppedEnrollments / totalEnrollments) * 100);

//shortlist rate
    const shortlistRate =
  totalApplications === 0
    ? 0
    : Math.round((shortlistedApplications / totalApplications) * 100);

const selectionRate =
  totalApplications === 0
    ? 0
    : Math.round((selectedApplications / totalApplications) * 100);


  return {
    totalReports,
    activeAlerts,

    dataAccuracy,

    // No uptime-monitoring history currently exists.
    systemUptime: null,

    users: {
      total: totalUsers,
      newThisMonth: newUsers,
      activeThisMonth: activeUsers,
    },

    learning: {
      totalEnrollments,
      completedEnrollments,
      droppedEnrollments,
      completionRate,
      dropoutRate
    },

    recruitment: {
      totalJobs,
      openJobs,
      totalApplications,
      shortlistedApplications,
      selectedApplications,
      rejectedApplications,
      shortlistRate,
      selectionRate
    },

    assessments: {
      totalAssessments,
      completedAssessments,
    },

   courseEngagement,

    userEngagement: [
      {
        channel: "New Users",
        value: newUsers,
      },
      {
        channel: "Active Users",
        value: activeUsers,
      },
    ],
  };
},
  },
  settings: {
    all: async () => {
      const rows = await prisma.setting.findMany({ where: { scope: "system" } });
      const map = {};
      for (const s of rows) map[s.key] = s.value;
      return map;
    },
    update: async (patch) => {
      const updates = Object.entries(patch || {}).map(([key, value]) =>
        prisma.setting.upsert({
          where: { scope_key: { scope: "system", key } },
          update: { value }, create: { scope: "system", key, value },
        })
      );

      await prisma.$transaction(updates);
      return module.exports.settings.all(); // Reuse all() to return the updated map
    },
  },

  lessons: {
    listByCourse: async (course_id) =>
      (await prisma.lesson.findMany({ where: { course_id }, orderBy: { order_index: "asc" }, include: { quizzes: true } })).map(mapLesson),
    findById: async (id) => mapLesson(await prisma.lesson.findUnique({ where: { id }, include: { quizzes: true } })),
    create: async (data) => mapLesson(await prisma.lesson.create({ data })),
    update: async (id, data) => mapLesson(await prisma.lesson.update({ where: { id }, data })),
    delete: async (id) => prisma.lesson.delete({ where: { id } }),
  },

  quizzes: {
    findByLessonId: async (lesson_id) => prisma.quiz.findFirst({ where: { lesson_id } }),
    create: async (data) => prisma.quiz.create({ data }),
    deleteByLessonId: async (lesson_id) => prisma.quiz.deleteMany({ where: { lesson_id } }),
  },

  assignments: {
    listByLesson: async (lesson_id) =>
      (await prisma.assignment.findMany({ where: { lesson_id } })).map(mapAssignment),
    create: async (data) => mapAssignment(await prisma.assignment.create({ data })),
  },

  progress: {
    listByUser: async (user_id) =>
      (await prisma.progress.findMany({ where: { user_id } })).map(mapProgress),
    upsert: async (user_id, lesson_id, patch) => {
      const data = {
        watched_duration: 0, quiz_score: null, assignment_status: "pending",
        completion_flag: false, ...patch,
      };
      const updateData = { ...patch };

      if ("completion_flag" in patch) {
        updateData.completed_at = patch.completion_flag
        ? new Date()
        : null;
}

      const saved = await prisma.progress.upsert({
          where: {
              user_id_lesson_id: {
                  user_id,
                  lesson_id,
              },
          },

          update: updateData,

          create: {
              ...data,
              user_id,
              lesson_id,
              completed_at: data.completion_flag
                  ? new Date()
                  : null,
          },
      });

      // Roll lesson-level progress up into the enrollment's completion_percentage,
      // so dashboards/certificates reflect real course progress instead of staying
      // at the 0 they're set to on enrollment.
      const lesson = await prisma.lesson.findUnique({ where: { id: lesson_id } });
      if (lesson) {
        const totalLessons = await prisma.lesson.count({
          where: { course_id: lesson.course_id },
        });
        if (totalLessons > 0) {
          const completedCount = await prisma.progress.count({
            where: {
              user_id,
              completion_flag: true,
              lesson: { course_id: lesson.course_id },
            },
          });
          const pct = Math.min(100, Math.round((completedCount / totalLessons) * 100));
          await prisma.enrollment.updateMany({
            where: { user_id, course_id: lesson.course_id },
            data: pct >= 100
              ? { completion_percentage: pct, status: "completed" }
              : { completion_percentage: pct },
          });
        }
      }

      return mapProgress(saved);
    },
  },

  certificates: {
  listByUser: async (user_id) =>
    (await prisma.certificate.findMany({ where: { user_id } })).map(mapCert),

  findByUserAndCourse: async (user_id, course_id) =>
    mapCert(
      await prisma.certificate.findFirst({
        where: { user_id, course_id },
      })
    ),

  create: async (data) => mapCert(await prisma.certificate.create({
    data: {
      certificate_code: `EDU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      ...data,
    },
  })),
},

  achievements: {
    listByUser: async (user_id) =>
      (await prisma.achievement.findMany({ where: { user_id } })).map(mapAch),
    create: async (data) => mapAch(await prisma.achievement.create({ data })),
  },

  tasks: {
    listByUser: async (user_id, filters = {}) => {
      const where = { user_id };
      if (filters.status) where.status = filters.status;
      return (await prisma.task.findMany({ where, orderBy: { due_date: "asc" } })).map(mapTask);
    },
    create: async (data) => mapTask(await prisma.task.create({ data })),
    update: async (id, user_id, data) => {
      const task = await prisma.task.findFirst({
        where: { id, user_id },
      });

      if (!task) return null;

      return mapTask(
        await prisma.task.update({
          where: { id },
          data,
        })
      );
    },
    remove: async (id, user_id) => {
    const task = await prisma.task.findFirst({
      where: {
        id,
        user_id,
      },
    });

    if (!task) return false;

    await prisma.task.delete({
      where: { id },
    });

    return true;
  },
  },

  recommendations: {
    listByUser: async (user_id) =>
      (await prisma.recommendation.findMany({ where: { user_id } })).map(mapRec),
    create: async (data) => mapRec(await prisma.recommendation.create({ data })),
  },

  announcements: {
    list: async () =>
      (
        await prisma.announcement.findMany({
          orderBy: { created_at: "desc" },
          include: {
            educator: {
              select: { id: true, name: true, email: true },
            },
          },
        })
      ).map(mapAnn),
    listByEducator: async (educator_id) =>
      (
        await prisma.announcement.findMany({
          where: { educator_id },
          orderBy: { created_at: "desc" },
          include: {
            educator: {
              select: { id: true, name: true, email: true },
            },
          },
        })
      ).map(mapAnn),
    create: async (data) =>
      mapAnn(
        await prisma.announcement.create({
          data,
          include: {
            educator: {
              select: { id: true, name: true, email: true },
            },
          },
        })
      ),
  },

  domainRoles: {
  list: async () =>
    prisma.domainRole.findMany({
      select: {
        domain_role_id: true,
        domain_name: true,
        category: true,
        created_at: true,
      },
      orderBy: {
        domain_name: "asc",
      },
    }),

  findById: async (domain_role_id) =>
    prisma.domainRole.findUnique({
      where: {
        domain_role_id,
      },
      include: {
        requiredSkills: {
          include: {
            skill: true,
          },
        },
      },
    }),

  findByName: async (domain_name) =>
    prisma.domainRole.findUnique({
      where: {
        domain_name,
      },
      include: {
        requiredSkills: {
          include: {
            skill: true,
          },
        },
      },
    }),

  create: async (data) =>
    prisma.domainRole.create({
      data,
    }),

  update: async (domain_role_id, data) =>
    safeQuery(
      prisma.domainRole.update({
        where: {
          domain_role_id,
        },
        data,
      })
    ),

  remove: async (domain_role_id) =>
    !!(
      await safeQuery(
        prisma.domainRole.delete({
          where: {
            domain_role_id,
          },
        })
      )
    ),
  },

  skills: {
  list: async () =>
    prisma.skill.findMany({
      orderBy: {
        skill_name: "asc",
      },
    }),

  findById: async (skill_id) =>
    prisma.skill.findUnique({
      where: {
        skill_id,
      },
    }),

  findByName: async (skill_name) =>
    prisma.skill.findUnique({
      where: {
        skill_name,
      },
    }),

  create: async (data) =>
    prisma.skill.create({
      data,
    }),

  update: async (skill_id, data) =>
    safeQuery(
      prisma.skill.update({
        where: {
          skill_id,
        },
        data,
      })
    ),

  remove: async (skill_id) =>
    !!(
      await safeQuery(
        prisma.skill.delete({
          where: {
            skill_id,
          },
        })
      )
    ),
  },

  domainRequiredSkills: {
  list: async () =>
    prisma.domainRequiredSkill.findMany({
      include: {
        domainRole: true,
        skill: true,
      },
      orderBy: [
        {
          domain_role_id: "asc",
        },
        {
          skill_id: "asc",
        },
      ],
    }),

  findById: async (domain_required_skill_id) =>
    prisma.domainRequiredSkill.findUnique({
      where: {
        domain_required_skill_id,
      },
      include: {
        domainRole: true,
        skill: true,
      },
    }),

    findByDomainRoleId: async (domainRoleId) =>
    prisma.domainRequiredSkill.findMany({
      where: {
        domain_role_id: domainRoleId,
      },
      include: {
        skill: true,
      },
      orderBy: [
        {
          skill_id: "asc",
        },
      ],
    }),

  create: async (data) =>
    prisma.domainRequiredSkill.create({
      data,
    }),

  update: async (domain_required_skill_id, data) =>
    safeQuery(
      prisma.domainRequiredSkill.update({
        where: {
          domain_required_skill_id,
        },
        data,
      })
    ),

  remove: async (domain_required_skill_id) =>
    !!(
      await safeQuery(
        prisma.domainRequiredSkill.delete({
          where: {
            domain_required_skill_id,
          },
        })
      )
    ),
  },

  difficultyLevels: {
  list: async () =>
    prisma.difficultyLevel.findMany({
      orderBy: {
        difficulty_order: "asc",
      },
    }),

  findById: async (id) =>
    prisma.difficultyLevel.findUnique({
      where: {
        id,
      },
    }),

  findByName: async (difficulty_name) =>
    prisma.difficultyLevel.findUnique({
      where: {
        difficulty_name,
      },
    }),

  create: async (data) =>
    prisma.difficultyLevel.create({
      data,
    }),

  update: async (id, data) =>
    safeQuery(
      prisma.difficultyLevel.update({
        where: {
          id,
        },
        data,
      })
    ),

  remove: async (id) =>
    !!(
      await safeQuery(
        prisma.difficultyLevel.delete({
          where: {
            id,
          },
        })
      )
    ),
  },

  questions: {
  list: async () =>
    prisma.question.findMany({
      include: {
        difficulty: true,
        skill: true,
      },
      orderBy: {
        question_id: "asc",
      },
    }),

  findById: async (question_id) =>
    prisma.question.findUnique({
      where: {
        question_id,
      },
      include: {
        difficulty: true,
        skill: true,
      },
    }),

  findBySkill: async (skill_id, assessment_type = "INITIAL") =>
  prisma.question.findMany({
    where: {
      skill_id,
      assessment_type,
    },
    include: {
      difficulty: true,
    },
    orderBy: {
      question_id: "asc",
    },
  }),

  findByDifficulty: async (difficulty_id) =>
    prisma.question.findMany({
      where: {
        difficulty_id,
      },
      include: {
        skill: true,
      },
      orderBy: {
        question_id: "asc",
      },
    }),

  create: async (data) =>
    prisma.question.create({
      data,
    }),

  update: async (question_id, data) =>
    safeQuery(
      prisma.question.update({
        where: {
          question_id,
        },
        data,
      })
    ),

  remove: async (question_id) =>
    !!(
      await safeQuery(
        prisma.question.delete({
          where: {
            question_id,
          },
        })
      )
    ),
  },

  quizSessions: {
  list: async () =>
    prisma.quizSession.findMany({
      include: {
        user: true,
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

  findById: async (session_id) =>
    prisma.quizSession.findUnique({
      where: {
        session_id,
      },
      include: {
        user: true,
        domainRole: true,
        answers: true,
        skillResults: true,
      },
    }),

  findByUserId: async (user_id) =>
    prisma.quizSession.findMany({
      where: {
        user_id,
      },
      include: {
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

  findLatestByUser: async (user_id, assessment_type = "INITIAL") =>
    prisma.quizSession.findFirst({
      where: {
        user_id,
        assessment_type,
      },
      include: {
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

  findLatestByUserAndAssessmentType: async ( user_id, assessment_type) =>
    prisma.quizSession.findFirst({
      where: {
        user_id,
        assessment_type,
      },
      include: {
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

  findActiveByUser: async (user_id, assessment_type = "INITIAL") =>
  prisma.quizSession.findFirst({
    where: {
      user_id,
      assessment_type,
      status: {
        in: ["In Progress", "Paused"],
      },
    },
    include: {
      domainRole: true,
    },
    orderBy: {
      start_time: "desc",
    },
  }),

  findInProgressByUser: async (user_id) =>
  prisma.quizSession.findFirst({
    where: {
      user_id,
      status: "In Progress",
    },
    include: {
      domainRole: true,
    },
    orderBy: {
      start_time: "desc",
    },
  }),

  findCompletedByUser: async (user_id) =>
    prisma.quizSession.findFirst({
      where: {
        user_id,
        status: "Completed",
      },
      include: {
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

  findCompletedByUserAndAssessmentType: async ( user_id, assessment_type ) =>
    prisma.quizSession.findFirst({
      where: {
        user_id,
        assessment_type,
        status: "Completed",
      },
      include: {
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

   create: async (data) => {
      return prisma.quizSession.create({
        data,
        include: {
          domainRole: true,
        },
      });
    },
  findActiveWithResumeData: async (user_id, assessment_type = "INITIAL") =>
    prisma.quizSession.findFirst({
      where: {
        user_id,
        assessment_type,
        status: "In Progress",
      },
      include: {
        domainRole: true,
      },
      orderBy: {
        start_time: "desc",
      },
    }),

  update: async (session_id, data) =>
    safeQuery(
      prisma.quizSession.update({
        where: {
          session_id,
        },
        data,
      })
    ),

  remove: async (session_id) =>
    !!(
      await safeQuery(
        prisma.quizSession.delete({
          where: {
            session_id,
          },
        })
      )
    ),
  },

 codingSessions: {
  findBySessionId: async (session_id) =>
    prisma.user_coding_sessions.findUnique({
      where: {
        session_id,
      },
    }),

  findByUserId: async (user_id) =>
    prisma.user_coding_sessions.findMany({
      where: {
        user_id,
      },
      orderBy: {
        started_at: "desc",
      },
    }),

  findBySessionAndUser: async (sessionId, userId) => {
    const session =
      await prisma.user_coding_sessions.findUnique({
        where: {
          session_id: Number(sessionId),
        },
      });

    if (!session) {
      return null;
    }

    if (String(session.user_id) !== String(userId)) {
      const error = new Error(
        "Coding session belongs to another user"
      );
      error.status = 409;
      throw error;
    }

    return session;
  },

  create: async (data) =>
    prisma.user_coding_sessions.create({
      data,
    }),

  update: async (session_id, data) =>
    safeQuery(
      prisma.user_coding_sessions.update({
        where: {
          session_id,
        },
        data,
      })
    ),
  },


  assessmentReports: {
    create: async (data) =>
      prisma.assessmentReport.create({
        data,
      }),

    findById: async (id) =>
      prisma.assessmentReport.findUnique({
        where: {
          id,
        },
        include: {
          student: true,
          quiz_session: {
            include: {
              domainRole: true,
              proctoring_events: {
                orderBy: {
                  created_at: "asc",
                },
              },
            },
          },
        },
      }),

    findByStudentAndSession: async (student_id, quiz_session_id) =>
      prisma.assessmentReport.findFirst({
        where: {
          student_id,
          quiz_session_id,
        },
      }),

    findByStudent: async (student_id) =>
      prisma.assessmentReport.findMany({
        where: {
          student_id,
        },
        include: {
          quiz_session: {
            include: {
              domainRole: true,
            },
          },
        },
        orderBy: {
          created_at: "desc",
        },
      }),

    list: async (status = null) =>
      prisma.assessmentReport.findMany({
        where: status ? { status } : undefined,
        include: {
          student: true,
          quiz_session: {
            include: {
              domainRole: true,
              proctoring_events: {
                orderBy: {
                  created_at: "asc",
                },
              },
            },
          },
        },
        orderBy: {
          created_at: "desc",
        },
      }),

    update: async (id, data) =>
      prisma.assessmentReport.update({
        where: {
          id,
        },
        data,
      }),
  },

  codingQuestions: {
    findById: async (question_id) =>
      prisma.coding_questions.findUnique({
        where: {
          question_id,
        },
        include: {
          coding_test_cases: true,
        },
      }),

    list: async () =>
      prisma.coding_questions.findMany({
        orderBy: {
          question_id: "asc",
        },
      }),

    findByIds: async (questionIds) =>
      prisma.coding_questions.findMany({
        where: {
          question_id: {
            in: questionIds,
          },
        },
        include: {
          coding_test_cases: true,
        },
      }),

    findUnseen: async (askedQuestionIds, limit = 3) =>
      prisma.coding_questions.findMany({
        where: askedQuestionIds.length
          ? {
              question_id: {
                notIn: askedQuestionIds,
              },
            }
          : {},
        orderBy: {
          question_id: "asc",
        },
        take: limit,
      }),
  },

  codingTestCases: {
    findByQuestionId: async (question_id) =>
      prisma.coding_test_cases.findMany({
        where: {
          question_id,
        },
        orderBy: {
          test_case_id: "asc",
        },
      }),
  },

  codingSubmissions: {
    findById: async (submission_id) =>
      prisma.coding_submissions.findUnique({
        where: {
          submission_id,
        },
        include: {
          coding_questions: true,
          submission_test_results: true,
        },
      }),

    findBySessionId: async (session_id) =>
      prisma.coding_submissions.findMany({
        where: {
          session_id,
        },
        include: {
          submission_test_results: true,
        },
        orderBy: {
          submitted_at: "desc",
        },
      }),

    create: async (data) =>
      prisma.coding_submissions.create({
        data,
      }),

    update: async (submission_id, data) =>
      safeQuery(
        prisma.coding_submissions.update({
          where: {
            submission_id,
          },
          data,
        }),
      ),

    getComparisonSubmissions: async (question_id, exclude_user_id) =>
      prisma.coding_submissions.findMany({
        where: {
          question_id,
          user_id: {
            not: exclude_user_id,
          },
          status: "PASSED", // Only compare against successful submissions (optional but good practice)
        },
        select: {
          submission_id: true,
          source_code: true,
        },
        take: 50, // Limit comparisons for performance
      }),
  },

  submissionTestResults: {
    findBySubmissionId: async (submission_id) =>
      prisma.submission_test_results.findMany({
        where: {
          submission_id,
        },
        orderBy: {
          result_id: "asc",
        },
      }),

    createMany: async (data) =>
      prisma.submission_test_results.createMany({
        data,
      }),
  },

  studentAskedQuestions: {
    find: async (user_id, question_id) =>
      prisma.student_asked_questions.findUnique({
        where: {
          user_id_question_id: {
            user_id,
            question_id,
          },
        },
      }),

    create: async (data) =>
      prisma.student_asked_questions.upsert({
        where: {
          user_id_question_id: {
            user_id: data.user_id,
            question_id: data.question_id,
          },
        },
        update: {},
        create: data,
      }),

    createMany: async (data) =>
      prisma.student_asked_questions.createMany({
        data,
        skipDuplicates: true,
      }),

    listByUser: async (user_id) =>
      prisma.student_asked_questions.findMany({
        where: {
          user_id,
        },
        orderBy: {
          asked_at: "asc",
        },
      }),

    listRecentByUser: async (user_id, limit = 3) =>
      prisma.student_asked_questions.findMany({
        where: {
          user_id,
        },
        orderBy: {
          asked_at: "desc",
        },
        take: limit,
      }),

    findAskedQuestionIds: async (user_id) => {
      const asked =
        await prisma.student_asked_questions.findMany({
          where: {
            user_id,
          },
          select: {
            question_id: true,
          },
        });

      return asked.map((item) => item.question_id);
    },
  },

  proctoringEvents: {
    create: async (data) =>
      prisma.proctoring_events.create({
        data,
      }),

    listBySessionId: async (session_id) =>
      prisma.proctoring_events.findMany({
        where: {
          session_id,
        },
        orderBy: {
          created_at: "asc",
        },
      }),

    findById: async (event_id) =>
      prisma.proctoring_events.findUnique({
        where: {
          event_id,
        },
      }),
  },

  plagiarismChecks: {
    create: async ({ submission_id, status, highest_similarity, comparison_count, matches = [] }) => {
      return prisma.plagiarism_checks.create({
        data: {
          submission_id,
          status: status || "completed",
          highest_similarity,
          comparison_count: comparison_count || 0,
          plagiarism_matches: {
            create: (matches || []).map((m) => ({
              matched_submission_id: m.submission_id,
              original_token_similarity: m.original_token_similarity,
              normalized_token_similarity: m.normalized_token_similarity,
              weighted_ast_similarity: m.weighted_ast_similarity,
              final_similarity: m.final_similarity,
              risk_level: m.risk_level,
            })),
          },
        },
        include: {
          plagiarism_matches: true,
        },
      });
    },

    findBySubmissionId: async (submission_id) => {
      return prisma.plagiarism_checks.findFirst({
        where: { submission_id },
        include: { plagiarism_matches: true },
        orderBy: { checked_at: "desc" },
      });
    },
  },


  studentAnswers: {
  list: async () =>
    prisma.studentAnswer.findMany({
      include: {
        session: true,
        question: true,
        skill: true,
        difficulty: true,
      },
    }),

  findById: async (id) =>
    prisma.studentAnswer.findUnique({
      where: { id },
      include: {
        session: true,
        question: true,
        skill: true,
        difficulty: true,
      },
    }),

  Id: async (sessionId) =>
    prisma.studentAnswer.findMany({
      where: {
        session_id: sessionId,
      },
      include: {
        question: true,
        skill: true,
        difficulty: true,
      },
      orderBy: {
        answered_at: "asc",
      },
    }),

  create: async (data) =>
    prisma.studentAnswer.create({
      data,
    }),

  createMany: async (data) =>
    prisma.studentAnswer.createMany({
      data,
    }),

  update: async (id, data) =>
    safeQuery(
      prisma.studentAnswer.update({
        where: { id },
        data,
      })
    ),

  remove: async (id) =>
    !!(
      await safeQuery(
        prisma.studentAnswer.delete({
          where: { id },
        })
      )
    ),
  },

  studentSkillResults: {
  list: async () =>
    prisma.studentSkillResult.findMany({
      include: {
        session: true,
        skill: true,
      },
    }),

  findById: async (id) =>
    prisma.studentSkillResult.findUnique({
      where: { id },
      include: {
        session: true,
        skill: true,
      },
    }),

  findBySessionId: async (sessionId) =>
    prisma.studentSkillResult.findMany({
      where: {
        session_id: sessionId,
      },
      include: {
        skill: true,
      },
      orderBy: {
        skill_id: "asc",
      },
    }),

  getQuizScoreBySessionId: async (sessionId) => {
    const results = await prisma.studentSkillResult.findMany({
      where: {
        session_id: sessionId,
      },
      select: {
        percentage: true,
      },
    });

    if (!results.length) {
      return null;
    }

    return Math.round(
      results.reduce(
        (sum, result) => sum + Number(result.percentage),
        0
      ) / results.length
    );
  },

  create: async (data) =>
    prisma.studentSkillResult.create({
      data,
    }),

  createMany: async (data) =>
    prisma.studentSkillResult.createMany({
      data,
    }),

  update: async (id, data) =>
    safeQuery(
      prisma.studentSkillResult.update({
        where: { id },
        data,
      })
    ),

  remove: async (id) =>
    !!(
      await safeQuery(
        prisma.studentSkillResult.delete({
          where: { id },
        })
      )
    ),
  },

  quizStates: {
    findById: async (session_id, skill_id) =>
      prisma.quiz_state.findUnique({
        where: {
          session_id_skill_id: {
            session_id,
            skill_id,
          },
        },
      }),

    create: async (data) => {
      try {
        return await prisma.quiz_state.create({
          data,
        });findBySession
      } catch (err) {

        // Another request already created this quiz state
        if (err.code === "P2002") {

          const existing =
            await prisma.quiz_state.findUnique({
              where: {
                session_id_skill_id: {
                  session_id: data.session_id,
                  skill_id: data.skill_id,
                },
              },
            });

          if (existing) {
            return existing;
          }
        }

        throw err;
      }
    },

    update: async (session_id, skill_id, data) =>
      safeQuery(
        prisma.quiz_state.update({
          where: {
            session_id_skill_id: {
              session_id,
              skill_id,
            },
          },
          data,
        })
      ),

    remove: async (session_id, skill_id) =>
      !!(
        await safeQuery(
          prisma.quiz_state.delete({
            where: {
              session_id_skill_id: {
                session_id,
                skill_id,
              },
            },
          })
        )
      ),

    findActiveByUser: async (user_id) =>
      prisma.quizSession.findFirst({
        where: {
          user_id,
          status: "In Progress",
        },
        orderBy: {
          start_time: "desc",
        },
      }),

      findBySessionId: async (session_id) =>
      prisma.quiz_state.findFirst({
        where: {
          session_id,
        },
      }),
  },

  communityPosts: {

    async create(data) {
      return mapCommunityPost(
        await prisma.community_posts.create({
          data,
          include: communityPostInclude,
        })
      );
    },

    async findById(id) {
      return mapCommunityPost(
        await prisma.community_posts.findUnique({
          where: { id },
          include: communityPostInclude,
        })
      );
    },

    async toggleBookmark(user_id, post_id) {
      const existing = await prisma.community_bookmarks.findFirst({
        where: { user_id, post_id },
      });

      if (existing) {
        await prisma.community_bookmarks.delete({
          where: { id: existing.id },
        });
        return { bookmarked: false };
      } else {
        await prisma.community_bookmarks.create({
          data: { user_id, post_id },
        });
        return { bookmarked: true };
      }
    },

    async getFeed({
      page = 1,
      limit = 10,
      post_type,
      visibility,
      author_id,
      user_role,
      current_user_id,
    } = {}) {

      const where = {
        deleted_at: null,
        status: "Published",
      };

      if (post_type) {
        where.post_type = post_type;
      }

      if (visibility) {
        where.visibility = visibility;
      }

      if (author_id) {
        where.author_id = author_id;
      }

      // Fetch posts (fetching buffer to account for role-filtered posts)
      const isViewerAdmin = user_role && user_role.toLowerCase() === "admin";
      const viewerRole = user_role ? user_role.toLowerCase() : null;
      const fetchTake = (!isViewerAdmin && viewerRole) ? Math.max(limit * 3, 50) : limit;

      const posts = await prisma.community_posts.findMany({
        where,
        include: communityPostInclude,
        orderBy: {
          created_at: "desc",
        },
        skip: (page - 1) * limit,
        take: fetchTake,
      });

      // Role visibility filter:
      // Admins can see all posts.
      // Authors can always see their own posts.
      // For others, if metadata.allowedRoles is specified, viewer's role must be included.
      const visiblePosts = posts.filter(p => {
        if (isViewerAdmin) return true;
        if (current_user_id && p.author_id === current_user_id) return true;

        const meta = p.metadata;
        if (meta && Array.isArray(meta.allowedRoles) && meta.allowedRoles.length > 0) {
          if (!viewerRole) return false;
          const allowed = meta.allowedRoles.map(r => String(r).toLowerCase());
          return allowed.includes(viewerRole);
        }
        return true;
      }).slice(0, limit);

      let bookmarkedPostIds = new Set();
      if (current_user_id && visiblePosts.length > 0) {
        const bookmarks = await prisma.community_bookmarks.findMany({
          where: {
            user_id: current_user_id,
            post_id: { in: visiblePosts.map((p) => p.id) },
          },
          select: { post_id: true },
        });
        bookmarkedPostIds = new Set(bookmarks.map((b) => b.post_id));
      }

      return visiblePosts.map((p) => {
        const mapped = mapCommunityPost(p);
        mapped.bookmarked = bookmarkedPostIds.has(p.id);
        return mapped;
      });
    },

    async findByAuthor(author_id) {
      return (
        await prisma.community_posts.findMany({
          where: {
            author_id,
            deleted_at: null,
          },
          include: communityPostInclude,
          orderBy: {
            created_at: "desc",
          },
        })
      ).map(mapCommunityPost);
    },

    async update(id, data) {
      return mapCommunityPost(
        await safeQuery(
          prisma.community_posts.update({
            where: { id },
            data,
            include: communityPostInclude,
          })
        )
      );
    },

    async softDelete(id) {
      return mapCommunityPost(
        await safeQuery(
          prisma.community_posts.update({
            where: { id },
            data: {
              deleted_at: new Date(),
            },
            include: communityPostInclude,
          })
        )
      );
    },

    async restore(id) {
      return mapCommunityPost(
        await safeQuery(
          prisma.community_posts.update({
            where: { id },
            data: {
              deleted_at: null,
            },
            include: communityPostInclude,
          })
        )
      );
    },

    async exists(id) {

      const count = await prisma.community_posts.count({
        where: {
          id,
          deleted_at: null,
        },
      });

      return count > 0;
    },

    async count(filters = {}) {

      const where = {
        deleted_at: null,
      };

      if (filters.author_id) {
        where.author_id = filters.author_id;
      }

      if (filters.post_type) {
        where.post_type = filters.post_type;
      }

      if (filters.status) {
        where.status = filters.status;
      }

      return prisma.community_posts.count({
        where,
      });
    },

    async incrementCommentCount(id) {
      return prisma.community_posts.update({
        where: { id },
        data: {
          comments_count: {
            increment: 1,
          },
        },
      });
    },

    async decrementCommentCount(id) {
      return prisma.community_posts.update({
        where: { id },
        data: {
          comments_count: {
            decrement: 1,
          },
        },
      });
    },

    async incrementReactionCount(id) {
      return prisma.community_posts.update({
        where: { id },
        data: {
          reactions_count: {
            increment: 1,
          },
        },
      });
    },

    async decrementReactionCount(id) {
      return prisma.community_posts.update({
        where: { id },
        data: {
          reactions_count: {
            decrement: 1,
          },
        },
      });
    },
  },

  miniProjects: {
    createAssignment: async (data) => {
      return prisma.miniProjectAssignment.create({
        data: {
          educator_id: data.educator_id,
          domain_role_id: data.domain_role_id,
          title: data.title,
          problem_statement: data.problem_statement,
          instructions: data.instructions || null,
          due_at: data.due_at || null,
          status: "DRAFT",
        },
        include: {
          domainRole: true,
          educator: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });
    },

    findAssignmentById: async (id) => {
      return safeQuery(
        prisma.miniProjectAssignment.findUnique({
          where: { id },
          include: {
            domainRole: true,
            educator: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            submissions: {
              select: {
                id: true,
                student_id: true,
                attempt_number: true,
                repository_url: true,
                branch: true,
                commit_sha: true,
                status: true,
                submitted_at: true,
                created_at: true,
                updated_at: true,
                analysis: {
                  select: {
                    id: true,
                    status: true,
                    static_analysis_status: true,
                    plagiarism_status: true,
                    ai_review_status: true,
                    readiness_score: true,
                    languages: true,
                    project_type: true,
                    started_at: true,
                    completed_at: true,
                    error_message: true,
                    created_at: true,
                    updated_at: true,
                  },
                },
              },
              orderBy: {
                attempt_number: "desc",
              },
            },
          },
        })
      );
    },

    publishAssignment: async (id, educatorId, dueAt) => {
      const data = {
        status: "PUBLISHED",
        assigned_at: new Date(),
      };

      if (dueAt !== undefined) {
        data.due_at = dueAt;
      }

      return safeQuery(
        prisma.miniProjectAssignment.updateMany({
          where: {
            id,
            educator_id: educatorId,
            status: "DRAFT",
          },
          data,
        })
      );
    },

    getCurrentForStudent: async (studentId, domainRoleId) => {
      return prisma.miniProjectAssignment.findFirst({
        where: {
          domain_role_id: domainRoleId,
          status: "PUBLISHED",
        },
        orderBy: {
          assigned_at: "desc",
        },
        include: {
          domainRole: true,
          educator: {
            select: {
              id: true,
              name: true,
            },
          },
          submissions: {
            where: {
              student_id: studentId,
            },
            orderBy: {
              created_at: "desc",
            },
            select: {
              id: true,
              assignment_id: true,
              student_id: true,
              attempt_number: true,
              repository_url: true,
              branch: true,
              commit_sha: true,
              status: true,
              submitted_at: true,
              created_at: true,
              updated_at: true,
              analysis: {
                select: {
                  id: true,
                  status: true,
                  static_analysis_status: true,
                  plagiarism_status: true,
                  ai_review_status: true,
                  readiness_score: true,
                  languages: true,
                  project_type: true,
                  started_at: true,
                  completed_at: true,
                  error_message: true,
                  created_at: true,
                  updated_at: true,
                },
              },
            },
          },
        },
      });
    },

    createSubmission: async ({
      assignmentId,
      studentId,
      repositoryUrl,
      branch,
      commitSha,
    }) => {
      return prisma.miniProjectSubmission.create({
        data: {
          assignment_id: assignmentId,
          student_id: studentId,
          attempt_number: 1,

          repository_url: repositoryUrl,
          branch: branch,
          commit_sha: commitSha,

          status: "SUBMITTED",
          submitted_at: new Date(),

          analysis: {
            create: {
              status: "QUEUED",
              static_analysis_status: "PENDING",
              plagiarism_status: "PENDING",
              ai_review_status: "NOT_REQUESTED",
            },
          },
        },
        include: {
          analysis: true,
        },
      });
    },

    findSubmissionByAssignmentAndStudent: async (
      assignmentId,
      studentId
    ) => {
      return safeQuery(
        prisma.miniProjectSubmission.findUnique({
          where: {
            assignment_id_student_id: {
              assignment_id: assignmentId,
              student_id: studentId,
            },
          },
          select: {
            id: true,
            assignment_id: true,
            student_id: true,
            attempt_number: true,
            repository_url: true,
            branch: true,
            commit_sha: true,
            status: true,
            submitted_at: true,
            created_at: true,
            updated_at: true,
            analysis: {
              select: {
                id: true,
                status: true,
                static_analysis_status: true,
                plagiarism_status: true,
                ai_review_status: true,
                readiness_score: true,
                languages: true,
                project_type: true,
                started_at: true,
                completed_at: true,
                error_message: true,
                created_at: true,
                updated_at: true,
              },
            },
          },
        })
      );
    },

    listStudentSubmissions: async (assignmentId, studentId) => {
      const submissions = await prisma.miniProjectSubmission.findMany({
        where: {
          assignment_id: assignmentId,
          student_id: studentId,
        },
        orderBy: {
          attempt_number: "desc",
        },
        select: {
          id: true,
          assignment_id: true,
          student_id: true,
          attempt_number: true,

          repository_url: true,
          branch: true,
          commit_sha: true,

          status: true,
          submitted_at: true,
          created_at: true,
          updated_at: true,

          analysis: {
            select: {
              id: true,
              status: true,
              static_analysis_status: true,
              plagiarism_status: true,
              ai_review_status: true,
              readiness_score: true,
              languages: true,
              project_type: true,
              started_at: true,
              completed_at: true,
              error_message: true,
              created_at: true,
              updated_at: true,
            },
          },
        },
      });

      return submissions;
    },

    listAssignmentsByEducator: async (educatorId) => {
      return safeQuery(
        prisma.miniProjectAssignment.findMany({
          where: {
            educator_id: educatorId,
          },
          orderBy: {
            created_at: "desc",
          },
          include: {
            domainRole: true,
            submissions: {
              select: {
                id: true,
                student_id: true,
                attempt_number: true,
                repository_url: true,
                branch: true,
                commit_sha: true,
                status: true,
                submitted_at: true,
                analysis: {
                  select: {
                    id: true,
                    status: true,
                    static_analysis_status: true,
                    plagiarism_status: true,
                    ai_review_status: true,
                    readiness_score: true,
                  },
                },
              },
              orderBy: {
                submitted_at: "desc",
              },
            },
          },
        })
      );
    },

    getAnalysisBySubmissionId: async (submissionId) => {
      return safeQuery(
        prisma.miniProjectAnalysis.findUnique({
          where: {
            submission_id: submissionId,
          },
          select: {
            id: true,
            submission_id: true,
            status: true,
            static_analysis_status: true,
            plagiarism_status: true,
            ai_review_status: true,
            readiness_score: true,
            languages: true,
            project_type: true,
            started_at: true,
            completed_at: true,
            error_message: true,
            created_at: true,
            updated_at: true,

            findings: {
              orderBy: {
                created_at: "asc",
              },
            },
          },
        })
      );
    },

    getQueuedAnalyses: async (limit = 5) => {
      return safeQuery(
        prisma.miniProjectAnalysis.findMany({
          where: {
            status: "QUEUED",
          },
          orderBy: {
            created_at: "asc",
          },
          take: limit,
          select: {
            id: true,
            submission_id: true,
            status: true,
            static_analysis_status: true,
            plagiarism_status: true,
            ai_review_status: true,
            submission: {
              select: {
                id: true,
                assignment_id: true,
                student_id: true,
                repository_url: true,
                branch: true,
                commit_sha: true,
              },
            },
          },
        })
      );
    },

    claimAnalysis: async (analysisId) => {
      return safeQuery(
        prisma.miniProjectAnalysis.updateMany({
          where: {
            id: analysisId,
            status: "QUEUED",
          },
          data: {
            status: "RUNNING",
            static_analysis_status: "RUNNING",
            started_at: new Date(),
            error_message: null,
          },
        })
      );
    },

    saveStaticAnalysisFindings: async (analysisId, findings = []) => {
      return safeQuery(
        prisma.$transaction(async (tx) => {
          await tx.staticAnalysisFinding.deleteMany({
            where: {
              analysis_id: analysisId,
            },
          });

          if (!findings.length) {
            return [];
          }

          await tx.staticAnalysisFinding.createMany({
            data: findings.map((finding) => ({
              analysis_id: analysisId,
              severity: finding.severity,
              category: finding.category,
              rule: finding.rule,
              file: finding.file,
              line: finding.line ?? null,
              message: finding.message,
            })),
          });

          return tx.staticAnalysisFinding.findMany({
            where: {
              analysis_id: analysisId,
            },
            orderBy: {
              created_at: "asc",
            },
          });
        })
      );
    },

    completeStaticAnalysis: async (
      analysisId,
      {
        languages,
        projectType,
      }
    ) => {
      return safeQuery(
        prisma.miniProjectAnalysis.update({
          where: {
            id: analysisId,
          },

          data: {
            static_analysis_status: "COMPLETED",
            languages,
            project_type: projectType,
            error_message: null,
          },
        })
      );
    },

    failStaticAnalysis: async (analysisId, errorMessage) => {
      return safeQuery(
        prisma.miniProjectAnalysis.update({
          where: {
            id: analysisId,
          },
          data: {
            status: "FAILED",
            static_analysis_status: "FAILED",
            completed_at: new Date(),
            error_message: errorMessage,
          },
        })
      );
    },

    recoverStuckAnalyses: async (timeoutMinutes = 15) => {
      const cutoffTime = new Date(
        Date.now() - timeoutMinutes * 60 * 1000
      );

      return safeQuery(
        prisma.miniProjectAnalysis.updateMany({
          where: {
            status: "RUNNING",
            started_at: {
              lt: cutoffTime,
            },
          },
          data: {
            status: "FAILED",
            completed_at: new Date(),
            error_message: `Analysis timed out after ${timeoutMinutes} minutes or worker was restarted.`,
          },
        })
      );
    },

    getComparisonSubmissions: async ({
      assignmentId,
      excludeSubmissionId,
      excludeStudentId,
    }) => {
      return prisma.miniProjectSubmission.findMany({
        where: {
          assignment_id: assignmentId,
          status: "SUBMITTED",

          id: {
            not: excludeSubmissionId,
          },

          student_id: {
            not: excludeStudentId,
          },

          commit_sha: {
            not: null,
          },
        },

        select: {
          id: true,
          assignment_id: true,
          student_id: true,
          repository_url: true,
          branch: true,
          commit_sha: true,
          status: true,
        },

        orderBy: {
          submitted_at: "asc",
        },
      });
    },

    createMiniProjectPlagiarismCheck: async (
      analysisId,
      {
        status,
        highestSimilarity,
        comparisonCount,
      }
    ) => {
      return prisma.miniProjectPlagiarismCheck.create({
        data: {
          analysis_id: analysisId,
          status,
          highest_similarity: highestSimilarity ?? null,
          comparison_count: comparisonCount ?? 0,
        },
      });
    },

    saveMiniProjectPlagiarismResult: async (
      analysisId,
      {
        status,
        highestSimilarity,
        comparisonCount,
        matches = [],
      }
    ) => {
      return prisma.$transaction(async (tx) => {
        const check = await tx.miniProjectPlagiarismCheck.upsert({
          where: {
            analysis_id: analysisId,
          },

          update: {
            status,
            highest_similarity: highestSimilarity ?? null,
            comparison_count: comparisonCount ?? 0,
          },

          create: {
            analysis_id: analysisId,
            status,
            highest_similarity: highestSimilarity ?? null,
            comparison_count: comparisonCount ?? 0,
          },
        });

        await tx.miniProjectPlagiarismMatch.deleteMany({
          where: {
            plagiarism_check_id: check.id,
          },
        });

        if (matches.length > 0) {
          await tx.miniProjectPlagiarismMatch.createMany({
            data: matches.map((match) => ({
              plagiarism_check_id: check.id,
              matched_submission_id: match.comparison_submission_id,
              similarity: match.similarity ?? null,
              risk_level: match.risk_level ?? null,
              matched_files: match.matched_files ?? null,
            })),
          });
        }

        return tx.miniProjectPlagiarismCheck.findUnique({
          where: {
            id: check.id,
          },
          include: {
            matches: true,
          },
        });
      });
    },

    getMiniProjectPlagiarismByAnalysisId: async (analysisId) => {
      return safeQuery(
        prisma.miniProjectPlagiarismCheck.findUnique({
          where: {
            analysis_id: analysisId,
          },

          include: {
            matches: {
              orderBy: {
                similarity: "desc",
              },
            },
          },
        })
      );
    },

    startPlagiarismAnalysis: async (analysisId) => {
      return safeQuery(
        prisma.miniProjectAnalysis.update({
          where: {
            id: analysisId,
          },

          data: {
            plagiarism_status: "RUNNING",
            error_message: null,
          },
        })
      );
    },

    completePlagiarismAnalysis: async (analysisId) => {
      return safeQuery(
        prisma.miniProjectAnalysis.update({
          where: {
            id: analysisId,
          },

          data: {
            plagiarism_status: "COMPLETED",
            status: "COMPLETED",
            completed_at: new Date(),
            error_message: null,
          },
        })
      );
    },

    failPlagiarismAnalysis: async (analysisId, errorMessage) => {
      return safeQuery(
        prisma.miniProjectAnalysis.update({
          where: {
            id: analysisId,
          },

          data: {
            plagiarism_status: "FAILED",
            status: "FAILED",
            completed_at: new Date(),
            error_message: errorMessage,
          },
        })
      );
    },

    updateMiniProjectReadinessScore: async (
      analysisId,
      readinessScore
    ) => {
      return safeQuery(
        prisma.miniProjectAnalysis.update({
          where: {
            id: analysisId,
          },
          data: {
            readiness_score: readinessScore,
          },
        })
      );
    },

  },

  adminRecentActivity: async (limit = 10) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);

    const [enrollments, progress, tasks, achievements, certificates] =

      await Promise.all([
        prisma.enrollment.findMany({
          take: safeLimit,
          orderBy: { enrolled_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),

        prisma.progress.findMany({
          where: {
            completion_flag: true,
            completed_at: { not: null },
          },
          take: safeLimit,
          orderBy: { completed_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            lesson: {
              select: {
                id: true,
                title: true,
                course: {
                  select: {
                    id: true,
                    title: true,
                  },
                },
              },
            },
          },
        }),

        prisma.task.findMany({
          where: {
            status: "done",
            completed_at: { not: null },
          },
          take: safeLimit,
          orderBy: { completed_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),

        prisma.achievement.findMany({
          take: safeLimit,
          orderBy: { earned_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        }),

        prisma.certificate.findMany({
          take: safeLimit,
          orderBy: { issued_date: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),
      ]);

    const activities = [
      ...enrollments.map((record) => ({
        id: `enrollment-${record.id}`,
        type: "enrollment",
        title: `Enrolled in "${record.course?.title || "a course"}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.enrolled_at,
      })),

      ...progress.map((record) => ({
        id: `lesson-${record.id}`,
        type: "lesson",
        title: `Completed lesson "${record.lesson?.title || "a lesson"}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.completed_at,
        course: record.lesson?.course
          ? {
              id: record.lesson.course.id,
              title: record.lesson.course.title,
            }
          : null,
      })),

      ...tasks.map((record) => ({
        id: `task-${record.id}`,
        type: "task",
        title: `Completed task "${record.title}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.completed_at,
        course: record.course
          ? {
              id: record.course.id,
              title: record.course.title,
            }
          : null,
      })),

      ...achievements.map((record) => ({
        id: `achievement-${record.id}`,
        type: "achievement",
        title: `Earned "${record.badge_name}" badge`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.earned_at,
      })),

      ...certificates.map((record) => ({
        id: `certificate-${record.id}`,
        type: "certificate",
        title: `Received certificate for "${record.course?.title || "a course"}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.issued_date,
        course: record.course
          ? {
              id: record.course.id,
              title: record.course.title,
            }
          : null,
      })),
    ]
      .filter((activity) => activity.when)
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, safeLimit);

    return activities;
  },

  insights: async () => {
    const [users, courses, enrollments, jobs, applications, assessments] =
      await Promise.all([
        prisma.enrollment.findMany({
          take: safeLimit,
          orderBy: { enrolled_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),

        prisma.progress.findMany({
          where: {
            completion_flag: true,
            completed_at: { not: null },
          },
          take: safeLimit,
          orderBy: { completed_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            lesson: {
              select: {
                id: true,
                title: true,
                course: {
                  select: {
                    id: true,
                    title: true,
                  },
                },
              },
            },
          },
        }),

        prisma.task.findMany({
          where: {
            status: "done",
            completed_at: { not: null },
          },
          take: safeLimit,
          orderBy: { completed_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),

        prisma.achievement.findMany({
          take: safeLimit,
          orderBy: { earned_at: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        }),

        prisma.certificate.findMany({
          take: safeLimit,
          orderBy: { issued_date: "desc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),
      ]);

    const activities = [
      ...enrollments.map((record) => ({
        id: `enrollment-${record.id}`,
        type: "enrollment",
        title: `Enrolled in "${record.course?.title || "a course"}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.enrolled_at,
      })),

      ...progress.map((record) => ({
        id: `lesson-${record.id}`,
        type: "lesson",
        title: `Completed lesson "${record.lesson?.title || "a lesson"}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.completed_at,
        course: record.lesson?.course
          ? {
              id: record.lesson.course.id,
              title: record.lesson.course.title,
            }
          : null,
      })),

      ...tasks.map((record) => ({
        id: `task-${record.id}`,
        type: "task",
        title: `Completed task "${record.title}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.completed_at,
        course: record.course
          ? {
              id: record.course.id,
              title: record.course.title,
            }
          : null,
      })),

      ...achievements.map((record) => ({
        id: `achievement-${record.id}`,
        type: "achievement",
        title: `Earned "${record.badge_name}" badge`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.earned_at,
      })),

      ...certificates.map((record) => ({
        id: `certificate-${record.id}`,
        type: "certificate",
        title: `Received certificate for "${record.course?.title || "a course"}"`,
        user: record.user
          ? {
              id: record.user.id,
              name: record.user.name,
              email: record.user.email,
            }
          : null,
        when: record.issued_date,
        course: record.course
          ? {
              id: record.course.id,
              title: record.course.title,
            }
          : null,
      })),
    ]
      .filter((activity) => activity.when)
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, safeLimit);

    return activities;
  },

  insights: async () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    users,
    courses,
    enrollments,
    jobs,
    applications,
    assessments,
    activeCourses,
    newCoursesThisMonth,
    completedEnrollments,
    newEnrollmentsThisMonth,
    activeEnrollments,
    openJobs,
    newJobsThisMonth,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.course.count(),
    prisma.enrollment.count(),
    prisma.job.count(),
    prisma.application.count(),
    prisma.assessment.findMany(),
    prisma.course.count({ where: { status: "active" } }),
    prisma.course.count({ where: { created_at: { gte: startOfMonth } } }),
    prisma.enrollment.count({ where: { status: "completed" } }),
    prisma.enrollment.count({
      where: { enrolled_at: { gte: startOfMonth } },
    }),
    prisma.enrollment.count({ where: { status: "active" } }),
    prisma.job.count({ where: { status: "open" } }),
    prisma.job.count({ where: { created_at: { gte: startOfMonth } } }),
  ]);

  const avgScore =
    assessments.length === 0
      ? 0
      : Math.round(
          assessments.reduce((s, a) => s + a.score, 0) /
            assessments.length
        );

  const courseCompletionRate =
    enrollments === 0
      ? 0
      : Math.round((completedEnrollments / enrollments) * 100);

  const enrollmentActiveRate =
    enrollments === 0
      ? 0
      : Math.round((activeEnrollments / enrollments) * 100);

  return {
    totals: {
      users,
      courses,
      enrollments,
      jobs,
      applications,
    },
    assessments: {
      count: assessments.length,
      average_score: avgScore,
    },
    top_missing_skills: [],
    courses: {
      active: activeCourses,
      new_this_month: newCoursesThisMonth,
      completion_rate: courseCompletionRate,
    },
    enrollments: {
      total: enrollments,
      new_this_month: newEnrollmentsThisMonth,
      active_rate: enrollmentActiveRate,
    },
    jobs: {
      open: openJobs,
      new_this_month: newJobsThisMonth,
      applications_received: applications,
    },
  };
},

  educatorInsights: async (educator_id, course_id = null) => {
    let targetEducatorId = educator_id;
    if (educator_id) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(educator_id);
      if (!isUUID) {
        const user = await prisma.user.findUnique({
          where: { clerk_id: educator_id },
          select: { id: true },
        });
        if (user) targetEducatorId = user.id;
      }
    }

    const allCourses = await prisma.course.findMany({
      where: { educator_id: targetEducatorId },
      orderBy: { created_at: "desc" },
    });

    let selectedCourses = allCourses;
    if (course_id && course_id !== "all") {
      selectedCourses = allCourses.filter((c) => c.id === course_id);
    }
    const courseIds = selectedCourses.map((c) => c.id);

    const enrollments =
      courseIds.length === 0
        ? []
        : await prisma.enrollment.findMany({
            where: {
              course_id: { in: courseIds },
            },
          });

    const enrolledUserIds = Array.from(new Set(enrollments.map((e) => e.user_id)));

    const avgCompletion =
      enrollments.length === 0
        ? 0
        : Math.round(
            enrollments.reduce(
              (sum, e) => sum + (e.completion_percentage || 0),
              0
            ) / enrollments.length
          );

    // Course ratings
    const ratings = courseIds.length === 0 ? [] : await prisma.courseRating.findMany({
      where: { course_id: { in: courseIds } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            profile: {
              select: { preferences: true },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
    const avgRating = ratings.length > 0
      ? Math.round((ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length) * 10) / 10
      : null;

    // Student Skill Results:
    // If students are enrolled in this educator's courses, query their results.
    // If no enrollments yet, analyze curriculum learner assessments for the course topics.
    let skillResultsWhere = {};
    if (enrolledUserIds.length > 0) {
      const sessions = await prisma.quizSession.findMany({
        where: { user_id: { in: enrolledUserIds }, status: "Completed" },
        select: { session_id: true },
      });
      skillResultsWhere = { session_id: { in: sessions.map((s) => s.session_id) } };
    }

    const skillResults = await prisma.studentSkillResult.findMany({
      where: skillResultsWhere,
      include: {
        skill: true,
        session: true,
      },
      orderBy: { created_at: "desc" },
    });

    // 1. Skill Gap Analysis
    const skillAgg = new Map();
    for (const r of skillResults) {
      const name = r.skill?.skill_name || "Unknown";
      const pct = parseFloat(r.percentage) || 0;
      if (!skillAgg.has(name)) {
        skillAgg.set(name, { sum: pct, count: 1 });
      } else {
        const item = skillAgg.get(name);
        item.sum += pct;
        item.count += 1;
      }
    }

    const skillGapAnalysis = Array.from(skillAgg.entries()).map(([skill, data]) => ({
      skill,
      value: Math.round(data.sum / data.count),
    }));

    // 2. Learner Proficiency
    let basicCount = 0;
    let intermediateCount = 0;
    let advancedCount = 0;

    const userScores = new Map();
    for (const r of skillResults) {
      const uId = r.session?.user_id || r.session_id;
      const pct = parseFloat(r.percentage) || 0;
      if (!userScores.has(uId)) {
        userScores.set(uId, [pct]);
      } else {
        userScores.get(uId).push(pct);
      }
    }

    for (const scores of userScores.values()) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (avg >= 70) {
        advancedCount++;
      } else if (avg >= 40) {
        intermediateCount++;
      } else {
        basicCount++;
      }
    }

    const learnerProficiency = {
      basic: basicCount,
      intermediate: intermediateCount,
      advanced: advancedCount,
    };

    // 3. Learner Performance (Weekly Trends)
    let sessionsWhere = { status: "Completed" };
    if (enrolledUserIds.length > 0) {
      sessionsWhere.user_id = { in: enrolledUserIds };
    }
    const completedSessions = await prisma.quizSession.findMany({
      where: sessionsWhere,
      orderBy: { end_time: "asc" },
    });

    const weeklyPerf = [
      { week: "Week 1", technical: 0, engagement: 0, count: 0 },
      { week: "Week 2", technical: 0, engagement: 0, count: 0 },
      { week: "Week 3", technical: 0, engagement: 0, count: 0 },
      { week: "Week 4", technical: 0, engagement: 0, count: 0 },
    ];

    const now = Date.now();
    const msDay = 24 * 60 * 60 * 1000;

    for (const s of completedSessions) {
      const ts = new Date(s.end_time || s.start_time).getTime();
      if (Number.isNaN(ts)) continue;
      const daysAgo = Math.floor((now - ts) / msDay);
      if (daysAgo < 0 || daysAgo >= 28) continue;
      const idx = 3 - Math.floor(daysAgo / 7);
      if (idx >= 0 && idx < 4) {
        const sessionResults = skillResults.filter((sr) => sr.session_id === s.session_id);
        const sessionAvg = sessionResults.length > 0
          ? sessionResults.reduce((sum, sr) => sum + (parseFloat(sr.percentage) || 0), 0) / sessionResults.length
          : 0;

        weeklyPerf[idx].technical += sessionAvg;
        weeklyPerf[idx].engagement += s.questions_answered || 10;
        weeklyPerf[idx].count += 1;
      }
    }

    const learnerPerformance = weeklyPerf.map((w) => ({
      week: w.week,
      technical: w.count > 0 ? Math.round(w.technical / w.count) : 0,
      engagement: Math.min(100, Math.round(w.engagement * 2)),
    }));

    // Upcoming pending tasks for educator and educator's courses
    let taskConditions = [];
    if (targetEducatorId) {
      taskConditions.push({ user_id: targetEducatorId, status: "pending" });
    }
    if (courseIds.length > 0) {
      taskConditions.push({ course_id: { in: courseIds }, status: "pending" });
    }
    const upcomingTasksCount = taskConditions.length > 0
      ? await prisma.task.count({ where: { OR: taskConditions } })
      : 0;

    return {
      courses: allCourses.map((c) => ({ id: c.id, title: c.title, status: c.status })),
      selectedCourseId: course_id || "all",
      enrolledLearners: enrolledUserIds.length,
      activeCourses: selectedCourses.filter((c) => c.status === "active").length,
      avgCompletion,
      avgRating,
      courseRatings: ratings.length,
      upcomingTasks: upcomingTasksCount,
      recentFeedbacks: ratings.slice(0, 10).map((r) => ({
        id: r.id,
        rating: r.rating,
        review: r.review,
        created_at: iso(r.created_at),
        course_id: r.course_id,
        course_title: allCourses.find((c) => c.id === r.course_id)?.title || "Course",
        user_name: r.user?.name || r.user?.username || "Student",
        avatar_url: r.user?.profile?.preferences?.avatar_url || null,
      })),
      learnerProficiency,
      skillGapAnalysis,
      learnerPerformance,
    };
  },

  employerInsights: async (employer_id) => {
  // Get employer's jobs
  const jobs = await prisma.job.findMany({
    where: { employer_id },
  });

  const jobIds = jobs.map((job) => job.id);

  // Actual applications
  const apps =
    jobIds.length === 0
      ? []
      : await prisma.application.findMany({
          where: {
            job_id: {
              in: jobIds,
            },
          },
        });

  // Count actual applicants
  const newApplicants = apps.length;

  // Candidate matching counts
  let strong = 0;
  let good = 0;
  let possible = 0;
  const skillsInsightsMap = new Map();

  // Get all active students
  const students = await prisma.user.findMany({
    where: {
      status: "active",
      role: {
        name: "student",
      },
    },
  });

  // Check every employer job
  for (const job of jobs) {
    // Find domain role using job title
    const domainRole = await prisma.domainRole.findFirst({
      where: {
        domain_name: {
          equals: job.title,
          mode: "insensitive",
        },
      },
    });

    if (!domainRole) continue;

    // Required skills for this job/domain
   const requiredSkills =
  await prisma.domainRequiredSkill.findMany({
    where: {
      domain_role_id: domainRole.domain_role_id,
    },
    include: {
      skill: {
        select: {
          skill_name: true,
        },
      },
    },
  });

    if (!requiredSkills.length) continue;

const domainStudents = students.filter(
  (student) =>
    student.domain_role_id ===
    (domainRole.domain_role_id || domainRole.id)
);

    for (const student of domainStudents) {



      // Latest completed assessment
      const completedSession =
        await prisma.quizSession.findFirst({
          where: {
            user_id: student.id,
            status: "Completed",
          },
          orderBy: {
            start_time: "desc",
          },
        });

     if (!completedSession) {
  continue;
}

      // Student's assessment results
      const skillResults =
        await prisma.studentSkillResult.findMany({
          where: {
            session_id:
              completedSession.session_id,
          },
        });

      const studentSkillMap = new Map();

      for (const result of skillResults) {
        studentSkillMap.set(
          Number(result.skill_id),
          Number(result.skill_level || 0)
        );
      }

      let totalScore = 0;
      let evaluatedSkills = 0;

      for (const requiredSkill of requiredSkills) {
        const requiredLevel = Number(
          requiredSkill.required_level || 0
        );

        const studentLevel =
          studentSkillMap.get(
            Number(requiredSkill.skill_id)
          ) || 0;

          const skillName = requiredSkill.skill?.skill_name;

if (skillName) {
  if (!skillsInsightsMap.has(skillName)) {
    skillsInsightsMap.set(skillName, {
      totalLevel: 0,
      totalPercentage: 0,
      candidates: 0,
      qualified: 0,
      requiredLevel,
    });
  }

  const insight = skillsInsightsMap.get(skillName);

  insight.totalLevel += studentLevel;
  insight.candidates += 1;

  if (studentLevel >= requiredLevel) {
    insight.qualified += 1;
  }
}

        if (requiredLevel <= 0) {
          totalScore += 1;
        } else {
          totalScore += Math.min(
            studentLevel / requiredLevel,
            1
          );
        }

        evaluatedSkills++;
      }

      const skillMatch =
        evaluatedSkills > 0
          ? Math.round(
              (totalScore / evaluatedSkills) * 100
            )
          : 0;



      if (skillMatch >= 80) {
        strong++;
      } else if (skillMatch >= 60) {
        good++;
      } else {
        possible++;
      }
    }
  }

const skillsInsights = Array.from(
  skillsInsightsMap.entries()
).map(([skill, data]) => ({
  skill,
  value:
    data.candidates > 0
      ? Math.round(
          (data.totalLevel / data.candidates) * 20
        )
      : 0,
  averageLevel:
    data.candidates > 0
      ? Number(
          (data.totalLevel / data.candidates).toFixed(1)
        )
      : 0,
  requiredLevel: data.requiredLevel,
  assessedCandidates: data.candidates,
  qualifiedCandidates: data.qualified,
}));


  const topMatches = strong;


// SKILL INSIGHTS
return {
    jobOpenings: jobs.filter(
      (job) => job.status === "open"
    ).length,

    newApplicants,

    topMatches,

    candidateMatches: {
      strong,
      good,
      possible,
    },

    skillsInsights,
  };
  },

  studentDashboard: async (user_id) => {
    const [
      user,
      initialAssessment,
      gapReport,
      enrollments,
      tasks,
      achievements,
      progress,
      certificates,
    ] = await Promise.all([

    prisma.user.findUnique({
      where: { id: user_id },
      select: {
        name: true,
        created_at:true,
        domain_role_id: true,

        domainRole: {
          select: {
            domain_role_id: true,
            domain_name: true,
            category: true,
          },
        },

        profile: {
          select: {
            initial_assessment_completed: true,
          },
        },
      },
    }),

    prisma.quizSession.findFirst({
    where: {
      user_id,
          status: "Completed",
        },
        orderBy: {
            end_time: "desc",
          },
          include: {
            skillResults: {
              include: {
                skill: {
                  select: {
                    skill_name: true,
                  },
                },
              },
            },
          },
        }),

    prisma.gapReport.findFirst({
      where: {
        user_id,
      },
    }),

      prisma.enrollment.findMany({
        where: { user_id },
        include: {
            course: {
                include: {
                    lessons: {
                        select: {
                            id: true,
                        },
                    },
                },
            },
        },
      }),

      prisma.task.findMany({
        where: { user_id },
        select: {
          id: true,
          title: true,
          status: true,
          created_at: true,
          completed_at: true,
          due_date: true,

          course: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      }),

      prisma.achievement.findMany({
        where: { user_id },
      }),

      prisma.progress.findMany({
        where: { user_id },
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              course: {
                select: {
                  id: true,
                  title: true,
                },
              },
            },
          },
        },
      }),

      prisma.certificate.findMany({
        where: { user_id },
        include: {
          course: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      }),
    ]);
    const learningSeconds = progress.reduce(
     (sum, record) => sum + (record.watched_duration || 0),0);

    const learningHoursLogged = Math.round(learningSeconds / 3600);
    const studentStartDate =
    enrollments.length > 0
      ? enrollments.reduce((earliest, enrollment) =>
          enrollment.enrolled_at < earliest
            ? enrollment.enrolled_at
            : earliest,
          enrollments[0].enrolled_at
        )
      : user?.created_at;

    const totalLessons = enrollments.reduce(
        (sum, enrollment) =>
          sum + enrollment.course.lessons.length,
        0
      );

      const completedLessons = progress.filter(
        (record) => record.completion_flag
      ).length;

      const learningProgressPercentage =
        totalLessons === 0
          ? 0
          : Math.round((completedLessons / totalLessons) * 100);

    const activeCourses = enrollments.filter(
      (enrollment) => enrollment.status === "active"
    ).length;

    const skillsReadiness = enrollments.length > 0 ? Math.round(enrollments.reduce(
                  (sum, enrollment) =>sum + (enrollment.completion_percentage || 0),0)
                  / enrollments.length): 0;

    const enrollmentActivities = enrollments.map((enrollment) => ({
      id: enrollment.id,
      title: `Enrolled in ${enrollment.course.title}`,
      when: enrollment.enrolled_at,
      type: "enrollment",
    }));

    const lessonActivities = progress.filter((record) => record.completion_flag)
      .map((record) => ({
        id: record.id,
        title: `Completed lesson "${record.lesson.title}"`,
        when: record.updated_at,
        type: "lesson",
      }));

    const taskActivities = tasks
      .filter((task) => task.status === "done")
      .map((task) => ({
        id: task.id,
        title: `Completed task "${task.title}"`,
        when: task.completed_at,
        type: "task",
      }));

    const achievementActivities = achievements.map((achievement) => ({
      id: achievement.id,
      title: `Earned "${achievement.badge_name}" badge`,
      when: achievement.earned_at,
      type: "achievement",
    }));

    const certificateActivities = certificates.map((certificate) => ({
      id: certificate.id,
      title: `Received certificate for ${certificate.course.title}`,
      when: certificate.issued_date,
      type: "certificate",
    }));

    const recentActivity = [
      ...enrollmentActivities,
      ...lessonActivities,
      ...taskActivities,
      ...achievementActivities,
      ...certificateActivities,
    ]
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, 5);
      // Learning Analytics
      const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

      // Student joined date
      const joinedDate =
        enrollments.length > 0
          ? enrollments.reduce(
              (earliest, enrollment) =>
                enrollment.enrolled_at < earliest
                  ? enrollment.enrolled_at
                  : earliest,
              enrollments[0].enrolled_at
            )
          : user?.created_at || new Date();

      // Number of weeks since joining
      const elapsedWeeks = Math.max(
        1,
        Math.ceil(
          (Date.now() - joinedDate.getTime()) /
            MS_PER_WEEK
        )
      );

      // Always show minimum 4 weeks
      const totalWeeks = Math.max(4, elapsedWeeks);

      // Readiness Score
      const readinessScore = gapReport?.readiness_score?? 0;

      const learningAnalytics = [];

      for (let week = 1; week <= totalWeeks; week++) {

        // Future week (no data yet)
        if (week > elapsedWeeks) {

          learningAnalytics.push({
            week,
            label: `Week ${week}`,

            readiness: null,

            lessonsCompleted: null,
            totalLessons,
            lessonPercentage: null,

            assignmentsCompleted: null,
            totalAssignments: tasks.length,
            assignmentPercentage: null,
          });

          continue;
        }

        const weekEnd = new Date(
          joinedDate.getTime() + week * MS_PER_WEEK
        );

        // Lessons completed until this week
        const lessonsCompleted = progress.filter(
          (record) =>
            record.completion_flag &&
            record.completed_at &&
            new Date(record.completed_at) <= weekEnd
        ).length;

        const lessonPercentage =
          totalLessons === 0
            ? 0
            : Math.round(
                (lessonsCompleted / totalLessons) * 100
              );

        // Assignments completed until this week
        const completedTasks = tasks.filter(
          (task) =>
            task.status === "done" &&
            task.completed_at &&
            new Date(task.completed_at) <= weekEnd
        ).length;

        const assignmentPercentage =
          tasks.length === 0
            ? 0
            : Math.round(
                (completedTasks / tasks.length) * 100
              );

        learningAnalytics.push({
          week,
          label: `Week ${week}`,

          readiness: readinessScore,

          lessonsCompleted,
          totalLessons,
          lessonPercentage,

          assignmentsCompleted: completedTasks,
          totalAssignments: tasks.length,
          assignmentPercentage,
        });

      }

        while(learningAnalytics.length < 4){
          const last = learningAnalytics[learningAnalytics.length - 1]

          learningAnalytics.push({
            ...last,
            week: learningAnalytics.length+1,
            label: `week ${learningAnalytics.length+1}`,
          })
        }



    return {
    studentName: user?.name,
    domainRoleId: user?.domain_role_id,
    domainRole: user?.domainRole?.domain_name || null,
    assessmentCompleted: !!user?.profile?.initial_assessment_completed,
    learningProgressPercentage,
    completedLessons,
    totalLessons,

    readinessScore,

    skillBreakdown:
      initialAssessment?.skillResults?.reduce(
        (acc, skill) => {
          acc[skill.skill.skill_name] = {
            percentage: Number(skill.percentage),
            skillLevel: skill.skill_level,
            obtainedScore: skill.obtained_score,
            maximumScore: skill.maximum_score,
          };
          return acc;
        },
        {}
      ) || {},

    coursesEnrolled: enrollments.length,
    activeCourses,
    achievementsCount: achievements.length,
    tasksDue: tasks.filter(task => task.status === "pending").length,
    learningHoursLogged,
    skillsReadiness,

    learningProgress: learningProgressByEnrollment(
      progress.filter((p) => p.completed_at),
      enrollments,
      "completed_at",
      () => 1
    ),

    engagementTrends: weeklyBuckets(
      progress,
      "updated_at",
      (p) => (p.watched_duration || 0) / 3600
    ),

    recentActivity,
    learningAnalytics,
    };
  },

};

