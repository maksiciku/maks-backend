"use strict";

const {
  rateLimit,
  ipKeyGenerator,
} = require("express-rate-limit");

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function safeIpKey(req) {
  return ipKeyGenerator(
    String(
      req.ip ||
        req.socket?.remoteAddress ||
        "unknown"
    )
  );
}

/*
 * Broad network protection.
 * Prevents one address from rapidly testing many accounts.
 */
const ccLoginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,

  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,

  keyGenerator: (req) => safeIpKey(req),

  handler: (req, res) => {
    return res.status(429).json({
      error:
        "Too many login attempts from this network. Try again later.",
      code: "CC_LOGIN_IP_LIMITED",
    });
  },
});

/*
 * Tighter account + network protection.
 */
const ccLoginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,

  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,

  keyGenerator: (req) => {
    const email = normalizeEmail(
      req.body?.email
    );

    return `${safeIpKey(req)}:${
      email || "missing-email"
    }`;
  },

  handler: (req, res) => {
    return res.status(429).json({
      error:
        "Too many failed attempts for this account. Try again later.",
      code: "CC_LOGIN_ACCOUNT_LIMITED",
    });
  },
});

module.exports = {
  ccLoginIpLimiter,
  ccLoginAccountLimiter,
};