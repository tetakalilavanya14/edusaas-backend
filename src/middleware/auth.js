const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config/env");
const { ROLE_PERMISSIONS } = require("../config/rbac");

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing or invalid Authorization header" });
  try {
    req.user = jwt.verify(token, jwtSecret);
    // Normalize: routes can rely on req.user.permissions being an array.
    if (!Array.isArray(req.user.permissions)) req.user.permissions = [];
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function roleRequired(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

// Permission-based guard. Pass one or more permission names; the user must have ALL of them.
// (admin always passes — admin role is seeded with every permission, but this short-circuits
// even if the token was issued before a permission was added to the catalog.)
function permissionRequired(...requiredPerms) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (req.user.role === "admin") return next();
    const defaultPerms = ROLE_PERMISSIONS[req.user.role] || [];
    const have = new Set([...(req.user.permissions || []), ...defaultPerms]);
    const missing = requiredPerms.filter((p) => !have.has(p));
    if (missing.length > 0) {
      return res.status(403).json({
        error: "Forbidden: missing permission",
        missing,
      });
    }
    next();
  };
}

module.exports = { authRequired, roleRequired, permissionRequired };
