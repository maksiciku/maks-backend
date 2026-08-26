"use strict";

const crypto = require("crypto");

function hashEdgeSecret(secret) {
  return crypto
    .createHash("sha256")
    .update(String(secret || ""), "utf8")
    .digest("hex");
}

function generateEdgeCredentials() {
  const installationId =
    crypto.randomUUID();

  const secret =
    `edge_${crypto
      .randomBytes(32)
      .toString("base64url")}`;

  return {
    installationId,
    secret,
    secretHash:
      hashEdgeSecret(secret),
  };
}

function edgeSecretMatches(
  storedHash,
  suppliedSecret
) {
  const expected =
    String(storedHash || "").trim();

  const actual =
    hashEdgeSecret(
      suppliedSecret
    );

  if (
    expected.length !== 64 ||
    actual.length !== 64
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(actual, "hex")
    );
  } catch {
    return false;
  }
}

module.exports = {
  hashEdgeSecret,
  generateEdgeCredentials,
  edgeSecretMatches,
};
