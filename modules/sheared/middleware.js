"use strict";

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../../config/db");

function passwordVersion(hash) {
  return crypto
    .createHash("sha256")
    .update(hash)
    .digest("hex");
}

// VERIFY TOKEN
async function verifyToken(req, res, next) {
  const bearer = req.headers.authorization?.match(
    /^Bearer (.+)$/i
  );

  const token = bearer
    ? bearer[1]
    : req.cookies?.token;

  if (!token) {
    return res.status(401).json({
      message: "No token provided."
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const [rows] = await db.execute(
      `SELECT id, name, email, role,
                    password, must_change_password
             FROM users
             WHERE id = ?
             LIMIT 1`,
      [decoded.id]
    );

    const user = rows[0];

    if (
      !user ||
      decoded.pwdv !== passwordVersion(user.password)
    ) {
      return res.status(401).json({
        message: "Session expired. Please log in again."
      });
    }

    const needsChange =
      Number(user.must_change_password) === 1;

    if (
      needsChange &&
      decoded.purpose !== "password_change"
    ) {
      return res.status(403).json({
        message: "Password change required.",
        mustChangePassword: true
      });
    }

    if (
      !needsChange &&
      decoded.purpose !== "access"
    ) {
      return res.status(403).json({
        message: "Please log in again."
      });
    }

    // A first-login token must not access normal APIs.
    if (
      decoded.purpose === "password_change" &&
      req.originalUrl.split("?")[0] !==
      "/api/signin/first-password/change"
    ) {
      return res.status(403).json({
        message: "Password change required.",
        mustChangePassword: true
      });
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      purpose: decoded.purpose,
      pwdv: decoded.pwdv,
      mustChangePassword: needsChange
    };

    next();

  } catch (error) {
    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError"
    ) {
      return res.status(401).json({
        message: "Invalid or expired token."
      });
    }

    console.error("VERIFY TOKEN ERROR:", error);

    return res.status(500).json({
      message: "Unable to verify session."
    });
  }
}

// NORMAL ACCESS ONLY
function requireAccess(req, res, next) {
  if (
    req.user?.purpose !== "access" ||
    req.user?.mustChangePassword
  ) {
    return res.status(403).json({
      message: "Change password before accessing this resource.",
      mustChangePassword: true
    });
  }

  next();
}

// ROLE-BASED ACCESS
function requireRole(...roles) {
  return (req, res, next) => {
    if (
      req.user?.purpose !== "access" ||
      req.user?.mustChangePassword
    ) {
      return res.status(403).json({
        message: "Password change required.",
        mustChangePassword: true
      });
    }

    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({
        message: "Access denied."
      });
    }

    next();
  };
}

// SUPER ADMIN MAY ACCESS ADVISER / COMMITTEE
function allowRoles(...roles) {
  return requireRole("super_admin", ...roles);
}

module.exports = verifyToken;

module.exports.verifyToken = verifyToken;
module.exports.requireAccess = requireAccess;
module.exports.requireRole = requireRole;
module.exports.allowRoles = allowRoles;

module.exports.isAdmin = requireRole("super_admin");
module.exports.isCommittee = allowRoles("committee");
module.exports.isAdviser = allowRoles("adviser");