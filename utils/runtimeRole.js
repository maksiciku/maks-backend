"use strict";

/*
 * =========================================================
 * MAKS RUNTIME AUTHORITY
 * =========================================================
 *
 * The same MAKS backend codebase may run in two places:
 *
 *   cloud  -> central MAKS Cloud authority
 *   edge   -> one restaurant's local MAKS Edge authority
 *
 * Directional sync producers MUST NOT guess their role from
 * DATABASE_URL, hostnames, ports, installation credentials,
 * or the presence of the Edge agent.
 *
 * MAKS_RUNTIME_ROLE is the explicit authority boundary.
 *
 * Missing role:
 *   - tolerated for legacy/non-directional runtime paths
 *   - MUST NOT be treated as Cloud
 *
 * Invalid role:
 *   - fail closed with an explicit configuration error
 */

const RUNTIME_ROLES =
  Object.freeze({
    CLOUD: "cloud",
    EDGE: "edge",
  });


class MaksRuntimeRoleError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "MaksRuntimeRoleError";

    this.code =
      code;

    if (details !== null) {
      this.details =
        details;
    }
  }
}


function normalizeRuntimeRole(
  value
) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const role =
    String(value)
      .trim()
      .toLowerCase();

  if (
    role !== RUNTIME_ROLES.CLOUD &&
    role !== RUNTIME_ROLES.EDGE
  ) {
    throw new MaksRuntimeRoleError(
      "MAKS_RUNTIME_ROLE_INVALID",
      "MAKS_RUNTIME_ROLE must be 'cloud' or 'edge'",
      {
        supplied_role:
          String(value).slice(
            0,
            100
          ),
      }
    );
  }

  return role;
}


function getRuntimeRole({
  env = process.env,
  required = false,
} = {}) {
  const role =
    normalizeRuntimeRole(
      env?.MAKS_RUNTIME_ROLE
    );

  if (
    !role &&
    required
  ) {
    throw new MaksRuntimeRoleError(
      "MAKS_RUNTIME_ROLE_MISSING",
      "MAKS_RUNTIME_ROLE is required for this operation"
    );
  }

  return role;
}


function isCloudRuntime(
  options = {}
) {
  return (
    getRuntimeRole(options) ===
    RUNTIME_ROLES.CLOUD
  );
}


function isEdgeRuntime(
  options = {}
) {
  return (
    getRuntimeRole(options) ===
    RUNTIME_ROLES.EDGE
  );
}


function canProduceCloudToEdgeEvents({
  env = process.env,
} = {}) {
  /*
   * Deliberately false when the role is missing.
   *
   * This is the critical fail-closed property:
   * old deployments do not suddenly become Cloud producers.
   */
  return (
    getRuntimeRole({
      env,
      required: false,
    }) ===
    RUNTIME_ROLES.CLOUD
  );
}


function assertCloudRuntime(
  options = {}
) {
  const role =
    getRuntimeRole({
      ...options,
      required: true,
    });

  if (
    role !== RUNTIME_ROLES.CLOUD
  ) {
    throw new MaksRuntimeRoleError(
      "MAKS_RUNTIME_ROLE_NOT_CLOUD",
      "This operation requires the MAKS Cloud runtime",
      {
        runtime_role:
          role,
      }
    );
  }

  return role;
}


module.exports = {
  RUNTIME_ROLES,
  MaksRuntimeRoleError,
  normalizeRuntimeRole,
  getRuntimeRole,
  isCloudRuntime,
  isEdgeRuntime,
  canProduceCloudToEdgeEvents,
  assertCloudRuntime,
};
