const {
  withTx,
} = require("../../dbCompat");

const {
  enqueueEdgeEventTx,
} = require("../syncStore");

const {
  isFinancialEdgeProducerRuntime,
} = require("./financialOperations");


const CASHUP_SESSION_CLOSED_EVENT_TYPE =
  "cashup.session.closed.v1";

const CASHUP_SESSION_CLOSED_SCHEMA_VERSION =
  1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


class CashupOperationalSyncError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "CashupOperationalSyncError";

    this.code = code;

    this.details =
      details || null;
  }
}


function fail(
  code,
  message,
  details = null
) {
  throw new CashupOperationalSyncError(
    code,
    message,
    details
  );
}


function requireTx(
  tx
) {
  if (
    !tx?.qGet ||
    !tx?.qAll ||
    !tx?.qRun
  ) {
    fail(
      "EDGE_CASHUP_TX_REQUIRED",
      "Cash-up Edge operations require an active database transaction"
    );
  }

  if (
    tx.kind !== "pg"
  ) {
    fail(
      "EDGE_CASHUP_POSTGRES_REQUIRED",
      "Cash-up Edge operations require PostgreSQL"
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
    fail(
      "EDGE_CASHUP_RESTAURANT_INVALID",
      "Cash-up event requires a valid restaurant_id"
    );
  }

  return rid;
}


function requireUuid(
  value,
  field
) {
  const uuid =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    !UUID_RE.test(uuid)
  ) {
    fail(
      "EDGE_CASHUP_UUID_INVALID",
      `${field} must be a valid UUID`
    );
  }

  return uuid;
}


function requireIso(
  value,
  field
) {
  const text =
    String(value || "")
      .trim();

  const date =
    new Date(text);

  if (
    !text ||
    Number.isNaN(
      date.getTime()
    )
  ) {
    fail(
      "EDGE_CASHUP_TIMESTAMP_INVALID",
      `${field} must be a valid timestamp`
    );
  }

  return date.toISOString();
}


function requireMoney(
  value,
  field
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    fail(
      "EDGE_CASHUP_MONEY_INVALID",
      `${field} must be a finite number`
    );
  }

  return Number(
    number.toFixed(2)
  );
}


function normalizeNullableText(
  value,
  maxLength
) {
  if (
    value == null
  ) {
    return null;
  }

  const text =
    String(value)
      .trim();

  if (!text) {
    return null;
  }

  return text.slice(
    0,
    maxLength
  );
}


function normalizePaymentUuids(
  value
) {
  if (
    !Array.isArray(value)
  ) {
    fail(
      "EDGE_CASHUP_PAYMENT_UUIDS_INVALID",
      "payment_uuids must be an array"
    );
  }

  if (
    value.length > 10000
  ) {
    fail(
      "EDGE_CASHUP_PAYMENT_UUIDS_TOO_LARGE",
      "cash-up event contains too many payment UUIDs"
    );
  }

  const unique =
    new Set();

  for (
    const raw of value
  ) {
    unique.add(
      requireUuid(
        raw,
        "payment_uuids[]"
      )
    );
  }

  return Array.from(unique);
}


function validateCashupSessionClosedPayload(
  value
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(
      "EDGE_CASHUP_PAYLOAD_INVALID",
      "Cash-up payload must be an object"
    );
  }

  if (
    Number(
      value.schema_version
    ) !==
    CASHUP_SESSION_CLOSED_SCHEMA_VERSION
  ) {
    fail(
      "EDGE_CASHUP_SCHEMA_VERSION_INVALID",
      "Unsupported cash-up event schema version"
    );
  }

  const rid =
    requireRestaurantId(
      value.restaurant_id
    );

  const session =
    value.session;

  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session)
  ) {
    fail(
      "EDGE_CASHUP_SESSION_INVALID",
      "Cash-up payload requires session"
    );
  }

  const id =
    requireUuid(
      session.id,
      "session.id"
    );

  const fromTs =
    requireIso(
      session.from_ts,
      "session.from_ts"
    );

  const toTs =
    requireIso(
      session.to_ts,
      "session.to_ts"
    );

  if (
    new Date(toTs) <
    new Date(fromTs)
  ) {
    fail(
      "EDGE_CASHUP_RANGE_INVALID",
      "Cash-up to_ts cannot be before from_ts"
    );
  }

  return {
    schema_version:
      CASHUP_SESSION_CLOSED_SCHEMA_VERSION,

    restaurant_id:
      rid,

    session: {
      id,

      from_ts:
        fromTs,

      to_ts:
        toTs,

      expected_cash:
        requireMoney(
          session.expected_cash,
          "session.expected_cash"
        ),

      actual_cash:
        requireMoney(
          session.actual_cash,
          "session.actual_cash"
        ),

      discrepancy:
        requireMoney(
          session.discrepancy,
          "session.discrepancy"
        ),

      note:
        normalizeNullableText(
          session.note,
          1000
        ),

      closed_by_name:
        normalizeNullableText(
          session.closed_by_name,
          255
        ),

      created_at:
        requireIso(
          session.created_at,
          "session.created_at"
        ),
    },

    payment_uuids:
      normalizePaymentUuids(
        value.payment_uuids
      ),
  };
}


function validateCashupSessionClosedEvent(
  event,
  {
    restaurantId,
    sourceInstallationId,
  }
) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const installationId =
    requireUuid(
      sourceInstallationId,
      "sourceInstallationId"
    );

  const eventId =
    requireUuid(
      event?.event_id,
      "event.event_id"
    );

  if (
    String(
      event?.event_type ||
      ""
    ) !==
    CASHUP_SESSION_CLOSED_EVENT_TYPE
  ) {
    fail(
      "EDGE_CASHUP_EVENT_TYPE_INVALID",
      "Unexpected cash-up event type"
    );
  }

  if (
    String(
      event?.entity_type ||
      ""
    ) !==
    "cashup_session"
  ) {
    fail(
      "EDGE_CASHUP_ENTITY_TYPE_INVALID",
      "Cash-up event entity_type must be cashup_session"
    );
  }

  const eventRid =
    requireRestaurantId(
      event.restaurant_id
    );

  if (
    eventRid !== rid
  ) {
    fail(
      "EDGE_CASHUP_TENANT_MISMATCH",
      "Cash-up event restaurant does not match authenticated Edge"
    );
  }

  const payload =
    validateCashupSessionClosedPayload(
      event.payload
    );

  if (
    payload.restaurant_id !==
    rid
  ) {
    fail(
      "EDGE_CASHUP_TENANT_MISMATCH",
      "Cash-up payload crossed restaurant boundary"
    );
  }

  const entityId =
    requireUuid(
      event.entity_id,
      "event.entity_id"
    );

  if (
    entityId !==
    payload.session.id
  ) {
    fail(
      "EDGE_CASHUP_SESSION_ID_MISMATCH",
      "Cash-up entity_id does not match session UUID"
    );
  }

  const expectedKey =
    `${CASHUP_SESSION_CLOSED_EVENT_TYPE}:${payload.session.id}`;

  if (
    String(
      event.idempotency_key ||
      ""
    ) !== expectedKey
  ) {
    fail(
      "EDGE_CASHUP_IDEMPOTENCY_MISMATCH",
      "Cash-up idempotency key does not match session UUID"
    );
  }

  return {
    event_id:
      eventId,

    restaurant_id:
      rid,

    source_installation_id:
      installationId,

    event_type:
      CASHUP_SESSION_CLOSED_EVENT_TYPE,

    entity_type:
      "cashup_session",

    entity_id:
      payload.session.id,

    idempotency_key:
      expectedKey,

    payload,
  };
}


async function loadCashupSessionClosedSnapshotTx(
  tx,
  {
    restaurantId,
    cashupSessionId,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const sessionId =
    requireUuid(
      cashupSessionId,
      "cashupSessionId"
    );

  const session =
    await tx.qGet(
      `
      SELECT
        id,
        restaurant_id,
        from_ts,
        to_ts,
        expected_cash,
        actual_cash,
        discrepancy,
        note,
        closed_by_name,
        created_at
      FROM public.cashup_sessions
      WHERE restaurant_id = $1
        AND id = $2::uuid
      `,
      [
        rid,
        sessionId,
      ]
    );

  if (!session) {
    fail(
      "EDGE_CASHUP_SESSION_NOT_FOUND",
      "Cash-up session was not found"
    );
  }

  const payments =
    await tx.qAll(
      `
      SELECT
        payment_uuid
      FROM public.payments
      WHERE restaurant_id = $1
        AND cashup_session_id = $2::uuid
      ORDER BY created_at ASC, id ASC
      `,
      [
        rid,
        sessionId,
      ]
    );

  return validateCashupSessionClosedPayload({
    schema_version:
      CASHUP_SESSION_CLOSED_SCHEMA_VERSION,

    restaurant_id:
      rid,

    session: {
      id:
        session.id,

      from_ts:
        session.from_ts,

      to_ts:
        session.to_ts,

      expected_cash:
        session.expected_cash,

      actual_cash:
        session.actual_cash,

      discrepancy:
        session.discrepancy,

      note:
        session.note,

      closed_by_name:
        session.closed_by_name,

      created_at:
        session.created_at,
    },

    payment_uuids:
      (payments || []).map(
        (row) =>
          row.payment_uuid
      ),
  });
}


async function emitCashupSessionClosedTx(
  tx,
  {
    restaurantId,
    cashupSessionId,
  }
) {
  requireTx(tx);

  if (
    !isFinancialEdgeProducerRuntime()
  ) {
    return null;
  }

  const payload =
    await loadCashupSessionClosedSnapshotTx(
      tx,
      {
        restaurantId,
        cashupSessionId,
      }
    );

  const sessionId =
    payload.session.id;

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          payload.restaurant_id,

        eventType:
          CASHUP_SESSION_CLOSED_EVENT_TYPE,

        entityType:
          "cashup_session",

        entityId:
          sessionId,

        idempotencyKey:
          `${CASHUP_SESSION_CLOSED_EVENT_TYPE}:${sessionId}`,

        payload,
      }
    );

  return {
    event,
    payload,
  };
}


async function applyCashupSessionClosedCloud({
  event,
  restaurantId,
  sourceInstallationId,
}) {
  const normalized =
    validateCashupSessionClosedEvent(
      event,
      {
        restaurantId,
        sourceInstallationId,
      }
    );

  const payload =
    normalized.payload;

  const session =
    payload.session;

  return withTx(
    async (tx) => {
      await tx.qGet(
        `
        SELECT
          pg_advisory_xact_lock(
            hashtextextended(
              $1,
              0
            )
          ) AS locked
        `,
        [
          `maks:cloud-cashup:${normalized.restaurant_id}:${session.id}`,
        ]
      );

      const inbox =
        await tx.qGet(
          `
          SELECT
            event_id,
            restaurant_id,
            source,
            source_installation_id,
            event_type,
            entity_type,
            entity_id,
            status,
            applied_at
          FROM public.edge_inbox
          WHERE event_id = $1::uuid
          FOR UPDATE
          `,
          [
            normalized.event_id,
          ]
        );

      if (!inbox) {
        fail(
          "EDGE_CASHUP_INBOX_REQUIRED",
          "Cash-up event must be durably received before Cloud apply"
        );
      }

      if (
        Number(
          inbox.restaurant_id
        ) !==
          normalized.restaurant_id ||

        String(
          inbox.source ||
          ""
        ) !==
          "edge" ||

        String(
          inbox.source_installation_id ||
          ""
        ).toLowerCase() !==
          normalized.source_installation_id ||

        String(
          inbox.event_type ||
          ""
        ) !==
          CASHUP_SESSION_CLOSED_EVENT_TYPE ||

        String(
          inbox.entity_type ||
          ""
        ) !==
          "cashup_session" ||

        String(
          inbox.entity_id ||
          ""
        ).toLowerCase() !==
          session.id
      ) {
        fail(
          "EDGE_CASHUP_INBOX_IDENTITY_MISMATCH",
          "Durable inbox identity does not match cash-up event"
        );
      }

      if (
        String(
          inbox.status ||
          ""
        ) ===
        "applied"
      ) {
        return {
          duplicate: true,
          cashup_session_id:
            session.id,
          payments_linked:
            0,
        };
      }

      if (
        ![
          "received",
          "failed",
        ].includes(
          String(
            inbox.status ||
            ""
          )
        )
      ) {
        fail(
          "EDGE_CASHUP_INBOX_STATE_INVALID",
          "Cash-up inbox event is not in an applicable state"
        );
      }

      const workerId =
        `cloud-cashup-inline:${normalized.source_installation_id}`;

      const claimed =
        await tx.qGet(
          `
          UPDATE public.edge_inbox
          SET
            status = 'applying',
            apply_attempts =
              apply_attempts + 1,
            locked_at = NOW(),
            locked_by = $3,
            last_attempt_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
          WHERE event_id = $1::uuid
            AND restaurant_id = $2
            AND status IN (
              'received',
              'failed'
            )
          RETURNING event_id
          `,
          [
            normalized.event_id,
            normalized.restaurant_id,
            workerId,
          ]
        );

      if (!claimed?.event_id) {
        fail(
          "EDGE_CASHUP_INBOX_CLAIM_FAILED",
          "Cash-up inbox event could not be claimed"
        );
      }

      const sameRange =
        await tx.qGet(
          `
          SELECT
            id
          FROM public.cashup_sessions
          WHERE restaurant_id = $1
            AND from_ts = $2
            AND to_ts = $3
          LIMIT 1
          FOR UPDATE
          `,
          [
            normalized.restaurant_id,
            session.from_ts,
            session.to_ts,
          ]
        );

      if (
        sameRange &&
        String(
          sameRange.id
        ).toLowerCase() !==
        session.id
      ) {
        fail(
          "EDGE_CASHUP_RANGE_CONFLICT",
          "Cloud already contains another cash-up UUID for this range"
        );
      }

      const existing =
        await tx.qGet(
          `
          SELECT
            id,
            restaurant_id,
            from_ts,
            to_ts,
            expected_cash,
            actual_cash,
            discrepancy,
            note,
            closed_by_name,
            created_at
          FROM public.cashup_sessions
          WHERE restaurant_id = $1
            AND id = $2::uuid
          FOR UPDATE
          `,
          [
            normalized.restaurant_id,
            session.id,
          ]
        );

      if (!existing) {
        await tx.qRun(
          `
          INSERT INTO public.cashup_sessions
          (
            id,
            restaurant_id,
            from_ts,
            to_ts,
            expected_cash,
            actual_cash,
            discrepancy,
            note,
            closed_by_user_id,
            closed_by_name,
            created_at
          )
          VALUES
          (
            $1::uuid,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NULL,
            $9,
            $10
          )
          `,
          [
            session.id,
            normalized.restaurant_id,
            session.from_ts,
            session.to_ts,
            session.expected_cash,
            session.actual_cash,
            session.discrepancy,
            session.note,
            session.closed_by_name,
            session.created_at,
          ]
        );
      } else {
        const same =
          String(
            new Date(
              existing.from_ts
            ).toISOString()
          ) === session.from_ts &&

          String(
            new Date(
              existing.to_ts
            ).toISOString()
          ) === session.to_ts &&

          Number(
            existing.expected_cash
          ).toFixed(2) ===
            Number(
              session.expected_cash
            ).toFixed(2) &&

          Number(
            existing.actual_cash
          ).toFixed(2) ===
            Number(
              session.actual_cash
            ).toFixed(2) &&

          Number(
            existing.discrepancy
          ).toFixed(2) ===
            Number(
              session.discrepancy
            ).toFixed(2);

        if (!same) {
          fail(
            "EDGE_CASHUP_SESSION_CONFLICT",
            "Cloud cash-up UUID already exists with different financial values"
          );
        }
      }

      let paymentsLinked =
        0;

      if (
        payload.payment_uuids.length
      ) {
        const rows =
          await tx.qAll(
            `
            SELECT
              payment_uuid,
              cashup_session_id
            FROM public.payments
            WHERE restaurant_id = $1
              AND payment_uuid =
                ANY($2::uuid[])
            FOR UPDATE
            `,
            [
              normalized.restaurant_id,
              payload.payment_uuids,
            ]
          );

        const found =
          new Map(
            (rows || []).map(
              (row) => [
                String(
                  row.payment_uuid
                ).toLowerCase(),
                row,
              ]
            )
          );

        const missing =
          payload
            .payment_uuids
            .filter(
              (uuid) =>
                !found.has(uuid)
            );

        if (
          missing.length
        ) {
          fail(
            "EDGE_CASHUP_PAYMENT_DEPENDENCY_MISSING",
            "Cash-up references payments not yet materialized on Cloud",
            {
              missing_payment_uuids:
                missing,
            }
          );
        }

        for (
          const uuid of
          payload.payment_uuids
        ) {
          const row =
            found.get(uuid);

          if (
            row.cashup_session_id &&
            String(
              row.cashup_session_id
            ).toLowerCase() !==
            session.id
          ) {
            fail(
              "EDGE_CASHUP_PAYMENT_ALREADY_CLOSED",
              "A payment is already linked to another cash-up session",
              {
                payment_uuid:
                  uuid,
              }
            );
          }
        }

        const linked =
          await tx.qRun(
            `
            UPDATE public.payments
            SET
              cashup_session_id =
                $1::uuid
            WHERE restaurant_id = $2
              AND payment_uuid =
                ANY($3::uuid[])
              AND cashup_session_id
                  IS NULL
            `,
            [
              session.id,
              normalized.restaurant_id,
              payload.payment_uuids,
            ]
          );

        paymentsLinked =
          Number(
            linked?.rowCount ??
            linked?.changes ??
            0
          );
      }

      const applied =
        await tx.qGet(
          `
          UPDATE public.edge_inbox
          SET
            status = 'applied',
            applied_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            last_error = NULL,
            updated_at = NOW()
          WHERE event_id = $1::uuid
            AND restaurant_id = $2
            AND status = 'applying'
            AND locked_by = $3
          RETURNING
            event_id,
            status,
            applied_at
          `,
          [
            normalized.event_id,
            normalized.restaurant_id,
            workerId,
          ]
        );

      if (
        !applied?.event_id ||
        String(
          applied.status ||
          ""
        ) !==
          "applied" ||
        !applied.applied_at
      ) {
        fail(
          "EDGE_CASHUP_INBOX_FINALIZE_FAILED",
          "Cash-up inbox event could not enter applied state"
        );
      }

      return {
        duplicate: false,

        cashup_session_id:
          session.id,

        payments_linked:
          paymentsLinked,
      };
    }
  );
}


module.exports = {
  CASHUP_SESSION_CLOSED_EVENT_TYPE,
  CASHUP_SESSION_CLOSED_SCHEMA_VERSION,
  CashupOperationalSyncError,
  validateCashupSessionClosedPayload,
  validateCashupSessionClosedEvent,
  loadCashupSessionClosedSnapshotTx,
  emitCashupSessionClosedTx,
  applyCashupSessionClosedCloud,
};
