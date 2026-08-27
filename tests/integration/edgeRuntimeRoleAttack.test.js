"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const {
  RUNTIME_ROLES,
  MaksRuntimeRoleError,
  normalizeRuntimeRole,
  getRuntimeRole,
  isCloudRuntime,
  isEdgeRuntime,
  canProduceCloudToEdgeEvents,
  assertCloudRuntime,
} = require(
  "../../utils/runtimeRole"
);


test(
  "missing role is tolerated but cannot produce Cloud to Edge events",
  () => {
    const env = {};

    assert.equal(
      getRuntimeRole({
        env,
      }),
      null
    );

    assert.equal(
      canProduceCloudToEdgeEvents({
        env,
      }),
      false
    );

    assert.equal(
      isCloudRuntime({
        env,
      }),
      false
    );

    assert.equal(
      isEdgeRuntime({
        env,
      }),
      false
    );
  }
);


test(
  "cloud role is normalized and is the only producer authority",
  () => {
    const env = {
      MAKS_RUNTIME_ROLE:
        "  CLOUD  ",
    };

    assert.equal(
      getRuntimeRole({
        env,
      }),
      RUNTIME_ROLES.CLOUD
    );

    assert.equal(
      canProduceCloudToEdgeEvents({
        env,
      }),
      true
    );

    assert.equal(
      isCloudRuntime({
        env,
      }),
      true
    );

    assert.equal(
      isEdgeRuntime({
        env,
      }),
      false
    );
  }
);


test(
  "edge role can never produce Cloud to Edge events",
  () => {
    const env = {
      MAKS_RUNTIME_ROLE:
        "edge",
    };

    assert.equal(
      getRuntimeRole({
        env,
      }),
      RUNTIME_ROLES.EDGE
    );

    assert.equal(
      canProduceCloudToEdgeEvents({
        env,
      }),
      false
    );

    assert.equal(
      isEdgeRuntime({
        env,
      }),
      true
    );

    assert.throws(
      () =>
        assertCloudRuntime({
          env,
        }),
      (error) =>
        error instanceof
          MaksRuntimeRoleError &&
        error.code ===
          "MAKS_RUNTIME_ROLE_NOT_CLOUD"
    );
  }
);


test(
  "invalid role fails closed instead of guessing authority",
  () => {
    const env = {
      MAKS_RUNTIME_ROLE:
        "primary",
    };

    assert.throws(
      () =>
        canProduceCloudToEdgeEvents({
          env,
        }),
      (error) =>
        error instanceof
          MaksRuntimeRoleError &&
        error.code ===
          "MAKS_RUNTIME_ROLE_INVALID"
    );
  }
);


test(
  "required runtime role rejects missing configuration",
  () => {
    assert.throws(
      () =>
        getRuntimeRole({
          env: {},
          required: true,
        }),
      (error) =>
        error instanceof
          MaksRuntimeRoleError &&
        error.code ===
          "MAKS_RUNTIME_ROLE_MISSING"
    );
  }
);


test(
  "normalizer accepts only the two explicit runtime roles",
  () => {
    assert.equal(
      normalizeRuntimeRole(
        "cloud"
      ),
      "cloud"
    );

    assert.equal(
      normalizeRuntimeRole(
        "EDGE"
      ),
      "edge"
    );

    assert.equal(
      normalizeRuntimeRole(
        ""
      ),
      null
    );

    assert.throws(
      () =>
        normalizeRuntimeRole(
          "cloud-edge"
        ),
      (error) =>
        error instanceof
          MaksRuntimeRoleError &&
        error.code ===
          "MAKS_RUNTIME_ROLE_INVALID"
    );
  }
);


test(
  "role is evaluated from the supplied environment at call time",
  () => {
    const env = {};

    assert.equal(
      canProduceCloudToEdgeEvents({
        env,
      }),
      false
    );

    env.MAKS_RUNTIME_ROLE =
      "cloud";

    assert.equal(
      canProduceCloudToEdgeEvents({
        env,
      }),
      true
    );

    env.MAKS_RUNTIME_ROLE =
      "edge";

    assert.equal(
      canProduceCloudToEdgeEvents({
        env,
      }),
      false
    );
  }
);
