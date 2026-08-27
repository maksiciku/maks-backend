"use strict";


class EdgeDomainRevisionError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "EdgeDomainRevisionError";

    this.code =
      code;

    if (details !== null) {
      this.details =
        details;
    }
  }
}


function requireTx(
  tx
) {
  if (
    !tx ||
    typeof tx.qGet !==
      "function" ||
    typeof tx.qRun !==
      "function"
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_TX_REQUIRED",
      "Edge domain revision operation requires a PostgreSQL transaction"
    );
  }

  return tx;
}


function requireRestaurantId(
  value
) {
  const rid =
    Number(value);

  if (
    !Number.isSafeInteger(rid) ||
    rid <= 0
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_RESTAURANT_INVALID",
      "Edge domain revision restaurantId must be a positive integer"
    );
  }

  return rid;
}


function requireDomain(
  value
) {
  const domain =
    String(
      value || ""
    ).trim();

  if (
    !domain ||
    domain.length > 200
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_NAME_INVALID",
      "Edge sync domain must contain 1 to 200 characters"
    );
  }

  return domain;
}


function requireRevision(
  value
) {
  const revision =
    Number(value);

  if (
    !Number.isSafeInteger(
      revision
    ) ||
    revision <= 0
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_REVISION_INVALID",
      "Edge domain revision must be a positive safe integer"
    );
  }

  return revision;
}


function requirePayloadHash(
  value
) {
  const hash =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    !/^[0-9a-f]{64}$/.test(
      hash
    )
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_HASH_INVALID",
      "Edge domain payload hash must be a SHA-256 hex digest"
    );
  }

  return hash;
}


async function ensureDomainRowTx(
  tx,
  {
    restaurantId,
    domain,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const domainSafe =
    requireDomain(
      domain
    );

  await tx.qRun(
    `
    INSERT INTO
      public.edge_domain_revisions
    (
      restaurant_id,
      domain
    )
    VALUES
    (
      $1,
      $2
    )
    ON CONFLICT (
      restaurant_id,
      domain
    )
    DO NOTHING
    `,
    [
      rid,
      domainSafe,
    ]
  );

  return {
    restaurantId:
      rid,
    domain:
      domainSafe,
  };
}


async function nextProducedRevisionTx(
  tx,
  {
    restaurantId,
    domain,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const domainSafe =
    requireDomain(
      domain
    );

  const row =
    await tx.qGet(
      `
      INSERT INTO
        public.edge_domain_revisions
      (
        restaurant_id,
        domain,
        produced_revision
      )
      VALUES
      (
        $1,
        $2,
        1
      )
      ON CONFLICT (
        restaurant_id,
        domain
      )
      DO UPDATE
      SET
        produced_revision =
          public.edge_domain_revisions
            .produced_revision + 1,

        updated_at = NOW()
      RETURNING
        produced_revision
      `,
      [
        rid,
        domainSafe,
      ]
    );

  return requireRevision(
    Number(
      row?.produced_revision
    )
  );
}


async function lockAppliedRevisionTx(
  tx,
  {
    restaurantId,
    domain,
    revision,
    payloadHash,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const domainSafe =
    requireDomain(
      domain
    );

  const revisionSafe =
    requireRevision(
      revision
    );

  const hashSafe =
    requirePayloadHash(
      payloadHash
    );

  await ensureDomainRowTx(
    tx,
    {
      restaurantId:
        rid,
      domain:
        domainSafe,
    }
  );

  const row =
    await tx.qGet(
      `
      SELECT
        applied_revision,
        applied_payload_hash
      FROM
        public.edge_domain_revisions
      WHERE
        restaurant_id = $1
        AND domain = $2
      FOR UPDATE
      `,
      [
        rid,
        domainSafe,
      ]
    );

  if (!row) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_STATE_MISSING",
      "Edge domain revision state disappeared while locking"
    );
  }

  const applied =
    Number(
      row.applied_revision ||
      0
    );

  if (
    revisionSafe < applied
  ) {
    return {
      state:
        "stale",
      restaurantId:
        rid,
      domain:
        domainSafe,
      revision:
        revisionSafe,
      appliedRevision:
        applied,
      payloadHash:
        hashSafe,
    };
  }

  if (
    revisionSafe === applied
  ) {
    const existingHash =
      row.applied_payload_hash
        ? String(
            row.applied_payload_hash
          ).toLowerCase()
        : null;

    if (
      existingHash ===
        hashSafe
    ) {
      return {
        state:
          "duplicate",
        restaurantId:
          rid,
        domain:
          domainSafe,
        revision:
          revisionSafe,
        appliedRevision:
          applied,
        payloadHash:
          hashSafe,
      };
    }

    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_REVISION_CONFLICT",
      "Edge domain revision was reused with a different payload",
      {
        domain:
          domainSafe,
        revision:
          revisionSafe,
      }
    );
  }

  return {
    state:
      "advance",
    restaurantId:
      rid,
    domain:
      domainSafe,
    revision:
      revisionSafe,
    appliedRevision:
      applied,
    payloadHash:
      hashSafe,
  };
}


async function completeAppliedRevisionTx(
  tx,
  state
) {
  requireTx(tx);

  if (
    !state ||
    state.state !==
      "advance"
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_ADVANCE_STATE_INVALID",
      "Edge domain revision completion requires an advance state"
    );
  }

  const row =
    await tx.qGet(
      `
      UPDATE
        public.edge_domain_revisions
      SET
        applied_revision = $3,
        applied_payload_hash = $4,
        updated_at = NOW()
      WHERE
        restaurant_id = $1
        AND domain = $2
        AND applied_revision = $5
      RETURNING
        applied_revision,
        applied_payload_hash
      `,
      [
        state.restaurantId,
        state.domain,
        state.revision,
        state.payloadHash,
        state.appliedRevision,
      ]
    );

  if (!row) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_REVISION_NOT_ADVANCED",
      "Edge domain revision could not be advanced"
    );
  }

  return {
    appliedRevision:
      Number(
        row.applied_revision
      ),
    payloadHash:
      String(
        row.applied_payload_hash
      ),
  };
}


async function applyDomainRevisionTx(
  tx,
  {
    restaurantId,
    domain,
    revision,
    payloadHash,
    execute,
  }
) {
  requireTx(tx);

  if (
    typeof execute !==
      "function"
  ) {
    throw new EdgeDomainRevisionError(
      "EDGE_DOMAIN_EXECUTE_REQUIRED",
      "Edge domain application requires an execute function"
    );
  }

  const state =
    await lockAppliedRevisionTx(
      tx,
      {
        restaurantId,
        domain,
        revision,
        payloadHash,
      }
    );

  if (
    state.state ===
      "stale" ||
    state.state ===
      "duplicate"
  ) {
    return {
      state:
        state.state,
      revision:
        state.revision,
      appliedRevision:
        state.appliedRevision,
      result:
        null,
    };
  }

  const result =
    await execute({
      tx,
      restaurantId:
        state.restaurantId,
      domain:
        state.domain,
      revision:
        state.revision,
    });

  const completed =
    await completeAppliedRevisionTx(
      tx,
      state
    );

  return {
    state:
      "applied",
    revision:
      state.revision,
    previousAppliedRevision:
      state.appliedRevision,
    appliedRevision:
      completed.appliedRevision,
    result:
      result ?? null,
  };
}


async function readDomainRevisionTx(
  tx,
  {
    restaurantId,
    domain,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const domainSafe =
    requireDomain(
      domain
    );

  return tx.qGet(
    `
    SELECT
      restaurant_id,
      domain,
      produced_revision,
      applied_revision,
      applied_payload_hash,
      created_at,
      updated_at
    FROM
      public.edge_domain_revisions
    WHERE
      restaurant_id = $1
      AND domain = $2
    LIMIT 1
    `,
    [
      rid,
      domainSafe,
    ]
  );
}


module.exports = {
  EdgeDomainRevisionError,
  nextProducedRevisionTx,
  applyDomainRevisionTx,
  readDomainRevisionTx,
};
