const jwt = require("jsonwebtoken");
const crypto = require("crypto")
const {
  jwtSecret,
  jwtExpiresIn,
  refreshJwtSecret,
  refreshJwtExpiresIn,
} = require("./env");

function buildPayload(user) {
  return {
    sub: user.id,
    clerk_id: user.clerk_id || null,
    role: user.role,
    permissions: user.permissions || [],
  };
}

function generateAccessToken(user) {
  return jwt.sign(buildPayload(user), jwtSecret, {
    expiresIn: jwtExpiresIn,
  });
}


function generateRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      jti: crypto.randomUUID(),
    },
    refreshJwtSecret,
    {
      expiresIn: refreshJwtExpiresIn,
    }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, jwtSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, refreshJwtSecret);
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};