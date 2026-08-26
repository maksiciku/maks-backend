"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const DATABASE_URL =
  String(
    process.env.DATABASE_URL || ""
  ).trim();

function uuid() {
  return crypto.randomUUID();
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(
      typeof value === "string"
        ? value
        : JSON.stringify(value)
    )
    .digest("hex");
}

test(
  "MAKS Edge sync storage attack",
  {
    timeout: 30000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );

    const pool =
      new Pool({
        connectionString:
          DATABASE_URL,
      });

    const safety =
      await pool.query(`
        SELECT current_database() AS db
      `);

    assert.equal(
      safety.rows?.[0]?.db,
      "maks_test",
      "REFUSED: Edge Sync Storage Attack may run only against maks_test"
    );

    console.log(
      "✅ Database guard: maks_test"
    );

    const restaurants =
      await pool.query(`
        SELECT id
        FROM public.restaurants
        WHERE id IN (1, 2)
        ORDER BY id
      `);

    assert.deepEqual(
      restaurants.rows.map(
        (row) =>
          Number(row.id)
      ),
      [1, 2],
      "REFUSED: expected Restaurant 1 and Restaurant 2 fixtures"
    );

    console.log(
      "✅ Tenant fixtures: Restaurant 1 + Restaurant 2"
    );

    const beforeCounts =
      await pool.query(`
        SELECT
          (SELECT COUNT(*)
           FROM public.edge_outbox)::bigint
            AS outbox,

          (SELECT COUNT(*)
           FROM public.edge_inbox)::bigint
            AS inbox,

          (SELECT COUNT(*)
           FROM public.edge_idempotency)::bigint
            AS idempotency,

          (SELECT COUNT(*)
           FROM public.edge_sync_state)::bigint
            AS sync_state
      `);

    const before =
      beforeCounts.rows[0];

    const client =
      await pool.connect();

    let savepointNumber = 0;

    async function expectReject(
      fn,
      {
        message,
        errorPattern = null,
      }
    ) {
      const savepoint =
        `edge_attack_sp_${++savepointNumber}`;

      await client.query(
        `SAVEPOINT ${savepoint}`
      );

      let caught = null;

      try {
        await fn();
      } catch (error) {
        caught = error;
      }

      await client.query(
        `ROLLBACK TO SAVEPOINT ${savepoint}`
      );

      await client.query(
        `RELEASE SAVEPOINT ${savepoint}`
      );

      assert.ok(
        caught,
        message
      );

      if (errorPattern) {
        assert.match(
          String(
            caught.message || ""
          ),
          errorPattern
        );
      }

      return caught;
    }

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    const payloadA = {
      test: true,
      token,
      table_number: "A1",
      item: "Burger",
    };

    const payloadB = {
      test: true,
      token,
      table_number: "B1",
      item: "Pizza",
    };

    try {
      await client.query(
        "BEGIN"
      );

      const outboxEventId =
        uuid();

      const outboxKey =
        `attack-outbox-${token}`;

      const outbox =
        await client.query(
          `
          INSERT INTO public.edge_outbox
          (
            event_id,
            restaurant_id,
            event_type,
            entity_type,
            entity_id,
            idempotency_key,
            payload,
            payload_hash
          )
          VALUES
          (
            $1,
            1,
            'pos.order.created',
            'pos_order',
            'attack-order-1',
            $2,
            $3::jsonb,
            $4
          )
          RETURNING
            id,
            status,
            retry_count
          `,
          [
            outboxEventId,
            outboxKey,
            JSON.stringify(
              payloadA
            ),
            hash(payloadA),
          ]
        );

      assert.equal(
        outbox.rows[0].status,
        "pending"
      );

      assert.equal(
        outbox.rows[0].retry_count,
        0
      );

      const outboxId =
        outbox.rows[0].id;

      console.log(
        "✅ 01 Valid outbox event accepted"
      );

      await t.test(
        "duplicate outbox event id rejected",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                INSERT INTO public.edge_outbox
                (
                  event_id,
                  restaurant_id,
                  event_type,
                  idempotency_key,
                  payload,
                  payload_hash
                )
                VALUES
                (
                  $1,
                  1,
                  'pos.order.created',
                  $2,
                  $3::jsonb,
                  $4
                )
                `,
                [
                  outboxEventId,
                  `another-${token}`,
                  JSON.stringify(
                    payloadA
                  ),
                  hash(payloadA),
                ]
              ),
            {
              message:
                "Duplicate outbox event_id was accepted",
            }
          );

          console.log(
            "✅ 02 Duplicate outbox event rejected"
          );
        }
      );

      await t.test(
        "duplicate outbox idempotency key rejected within tenant",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                INSERT INTO public.edge_outbox
                (
                  event_id,
                  restaurant_id,
                  event_type,
                  idempotency_key,
                  payload,
                  payload_hash
                )
                VALUES
                (
                  $1,
                  1,
                  'pos.order.created',
                  $2,
                  $3::jsonb,
                  $4
                )
                `,
                [
                  uuid(),
                  outboxKey,
                  JSON.stringify(
                    payloadA
                  ),
                  hash(payloadA),
                ]
              ),
            {
              message:
                "Duplicate tenant idempotency key was accepted",
            }
          );

          console.log(
            "✅ 03 Same-tenant outbox replay rejected"
          );
        }
      );

      await t.test(
        "same outbox idempotency key allowed in another tenant",
        async () => {
          const result =
            await client.query(
              `
              INSERT INTO public.edge_outbox
              (
                event_id,
                restaurant_id,
                event_type,
                idempotency_key,
                payload,
                payload_hash
              )
              VALUES
              (
                $1,
                2,
                'pos.order.created',
                $2,
                $3::jsonb,
                $4
              )
              RETURNING id
              `,
              [
                uuid(),
                outboxKey,
                JSON.stringify(
                  payloadB
                ),
                hash(payloadB),
              ]
            );

          assert.equal(
            result.rowCount,
            1
          );

          console.log(
            "✅ 04 Tenant namespace isolation proven"
          );
        }
      );

      await t.test(
        "outbox payload and tenant are immutable",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_outbox
                SET payload =
                  '{"tampered":true}'::jsonb
                WHERE id = $1
                `,
                [outboxId]
              ),
            {
              message:
                "Outbox payload mutation was accepted",
              errorPattern:
                /immutable/i,
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_outbox
                SET restaurant_id = 2
                WHERE id = $1
                `,
                [outboxId]
              ),
            {
              message:
                "Outbox tenant mutation was accepted",
              errorPattern:
                /immutable/i,
            }
          );

          console.log(
            "✅ 05 Outbox identity/content immutability proven"
          );
        }
      );

      await t.test(
        "negative or decreasing outbox retry count rejected",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_outbox
                SET retry_count = -1
                WHERE id = $1
                `,
                [outboxId]
              ),
            {
              message:
                "Negative retry count was accepted",
            }
          );

          await client.query(
            `
            UPDATE public.edge_outbox
            SET retry_count = 2
            WHERE id = $1
            `,
            [outboxId]
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_outbox
                SET retry_count = 1
                WHERE id = $1
                `,
                [outboxId]
              ),
            {
              message:
                "Outbox retry count moved backwards",
              errorPattern:
                /cannot decrease/i,
            }
          );

          console.log(
            "✅ 06 Outbox retry monotonicity proven"
          );
        }
      );

      await t.test(
        "outbox legal delivery progression works and terminal ACK cannot reopen",
        async () => {
          await client.query(
            `
            UPDATE public.edge_outbox
            SET
              status = 'in_flight',
              locked_at = NOW(),
              locked_by = 'edge-attack-worker',
              last_attempt_at = NOW(),
              retry_count =
                retry_count + 1,
              updated_at = NOW()
            WHERE id = $1
            `,
            [outboxId]
          );

          await client.query(
            `
            UPDATE public.edge_outbox
            SET
              status = 'acked',
              acked_at = NOW(),
              locked_at = NULL,
              locked_by = NULL,
              updated_at = NOW()
            WHERE id = $1
            `,
            [outboxId]
          );

          const acked =
            await client.query(
              `
              SELECT
                status,
                acked_at
              FROM public.edge_outbox
              WHERE id = $1
              `,
              [outboxId]
            );

          assert.equal(
            acked.rows[0].status,
            "acked"
          );

          assert.ok(
            acked.rows[0].acked_at
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_outbox
                SET
                  status = 'pending',
                  acked_at = NULL
                WHERE id = $1
                `,
                [outboxId]
              ),
            {
              message:
                "ACKed event was reopened",
              errorPattern:
                /terminal|cannot be reopened/i,
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_outbox
                SET
                  acked_at =
                    acked_at
                    + INTERVAL '1 second'
                WHERE id = $1
                `,
                [outboxId]
              ),
            {
              message:
                "ACK timestamp was mutable",
              errorPattern:
                /acknowledgement timestamp is immutable/i,
            }
          );

          console.log(
            "✅ 07 Outbox state machine proven"
          );
        }
      );

      const inboxEventId =
        uuid();

      const inbox =
        await client.query(
          `
          INSERT INTO public.edge_inbox
          (
            event_id,
            restaurant_id,
            source,
            event_type,
            entity_type,
            entity_id,
            payload,
            payload_hash
          )
          VALUES
          (
            $1,
            1,
            'cloud',
            'menu.item.updated',
            'menu_item',
            'attack-menu-1',
            $2::jsonb,
            $3
          )
          RETURNING id
          `,
          [
            inboxEventId,
            JSON.stringify(
              payloadA
            ),
            hash(payloadA),
          ]
        );

      const inboxId =
        inbox.rows[0].id;

      console.log(
        "✅ 08 Valid inbox event accepted"
      );

      await t.test(
        "inbox replay and payload mutation rejected",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                INSERT INTO public.edge_inbox
                (
                  event_id,
                  restaurant_id,
                  source,
                  event_type,
                  payload,
                  payload_hash
                )
                VALUES
                (
                  $1,
                  1,
                  'cloud',
                  'menu.item.updated',
                  $2::jsonb,
                  $3
                )
                `,
                [
                  inboxEventId,
                  JSON.stringify(
                    payloadA
                  ),
                  hash(payloadA),
                ]
              ),
            {
              message:
                "Inbox replay was accepted",
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_inbox
                SET payload =
                  '{"tampered":true}'::jsonb
                WHERE id = $1
                `,
                [inboxId]
              ),
            {
              message:
                "Inbox payload mutation was accepted",
              errorPattern:
                /immutable/i,
            }
          );

          console.log(
            "✅ 09 Inbox replay/content protection proven"
          );
        }
      );

      await t.test(
        "inbox legal apply progression works and applied state cannot reopen",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_inbox
                SET
                  status = 'applying',
                  apply_attempts =
                    apply_attempts + 1,
                  last_attempt_at = NOW(),
                  updated_at = NOW()
                WHERE id = $1
                `,
                [inboxId]
              ),
            {
              message:
                "Inbox event entered applying without a worker lease",
            }
          );

          await client.query(
            `
            UPDATE public.edge_inbox
            SET
              status = 'applying',
              apply_attempts =
                apply_attempts + 1,
              locked_at = NOW(),
              locked_by =
                'edge-attack-worker',
              last_attempt_at = NOW(),
              updated_at = NOW()
            WHERE id = $1
            `,
            [inboxId]
          );

          await client.query(
            `
            UPDATE public.edge_inbox
            SET
              status = 'applied',
              applied_at = NOW(),
              locked_at = NULL,
              locked_by = NULL,
              updated_at = NOW()
            WHERE id = $1
            `,
            [inboxId]
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_inbox
                SET
                  status = 'received',
                  applied_at = NULL
                WHERE id = $1
                `,
                [inboxId]
              ),
            {
              message:
                "Applied inbox event was reopened",
              errorPattern:
                /terminal|cannot be reopened/i,
            }
          );

          console.log(
            "✅ 10 Inbox state machine proven"
          );
        }
      );

      const idemKey =
        `attack-idem-${token}`;

      const idemHash =
        hash({
          operation:
            "submit-order",
          token,
        });

      const idem =
        await client.query(
          `
          INSERT INTO public.edge_idempotency
          (
            restaurant_id,
            scope,
            idempotency_key,
            request_hash
          )
          VALUES
          (
            1,
            'pos.submit-order',
            $1,
            $2
          )
          RETURNING id
          `,
          [
            idemKey,
            idemHash,
          ]
        );

      const idemId =
        idem.rows[0].id;

      console.log(
        "✅ 11 Valid idempotency record accepted"
      );

      await t.test(
        "idempotency replay is tenant and scope aware",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                INSERT INTO public.edge_idempotency
                (
                  restaurant_id,
                  scope,
                  idempotency_key,
                  request_hash
                )
                VALUES
                (
                  1,
                  'pos.submit-order',
                  $1,
                  $2
                )
                `,
                [
                  idemKey,
                  idemHash,
                ]
              ),
            {
              message:
                "Duplicate idempotency execution was accepted",
            }
          );

          const otherScope =
            await client.query(
              `
              INSERT INTO public.edge_idempotency
              (
                restaurant_id,
                scope,
                idempotency_key,
                request_hash
              )
              VALUES
              (
                1,
                'pos.pay-order',
                $1,
                $2
              )
              RETURNING id
              `,
              [
                idemKey,
                idemHash,
              ]
            );

          assert.equal(
            otherScope.rowCount,
            1
          );

          const otherTenant =
            await client.query(
              `
              INSERT INTO public.edge_idempotency
              (
                restaurant_id,
                scope,
                idempotency_key,
                request_hash
              )
              VALUES
              (
                2,
                'pos.submit-order',
                $1,
                $2
              )
              RETURNING id
              `,
              [
                idemKey,
                idemHash,
              ]
            );

          assert.equal(
            otherTenant.rowCount,
            1
          );

          console.log(
            "✅ 12 Idempotency tenant/scope isolation proven"
          );
        }
      );

      await t.test(
        "idempotency fingerprint and completed state are immutable",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_idempotency
                SET request_hash = $2
                WHERE id = $1
                `,
                [
                  idemId,
                  hash(
                    "different-request"
                  ),
                ]
              ),
            {
              message:
                "Idempotency request fingerprint changed",
              errorPattern:
                /immutable/i,
            }
          );

          await client.query(
            `
            UPDATE public.edge_idempotency
            SET
              status = 'completed',
              response_status = 200,
              response_body =
                '{"ok":true}'::jsonb,
              completed_at = NOW(),
              updated_at = NOW()
            WHERE id = $1
            `,
            [idemId]
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_idempotency
                SET
                  status = 'in_progress',
                  completed_at = NULL
                WHERE id = $1
                `,
                [idemId]
              ),
            {
              message:
                "Completed idempotency record was reopened",
              errorPattern:
                /terminal|cannot be reopened/i,
            }
          );

          console.log(
            "✅ 13 Idempotency replay barrier proven"
          );
        }
      );

      const installationId =
        uuid();

      await client.query(
        `
        INSERT INTO public.edge_sync_state
        (
          restaurant_id,
          installation_id,
          sync_status
        )
        VALUES
        (
          1,
          $1,
          'unknown'
        )
        `,
        [installationId]
      );

      console.log(
        "✅ 14 Valid sync-state record accepted"
      );

      await t.test(
        "sync state rejects invalid counters and status",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_sync_state
                SET sync_status =
                  'magically_synced'
                WHERE
                  restaurant_id = 1
                  AND installation_id = $1
                `,
                [installationId]
              ),
            {
              message:
                "Invalid sync status was accepted",
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_sync_state
                SET pending_outbox_events = -1
                WHERE
                  restaurant_id = 1
                  AND installation_id = $1
                `,
                [installationId]
              ),
            {
              message:
                "Negative pending outbox count was accepted",
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_sync_state
                SET pending_inbox_events = -1
                WHERE
                  restaurant_id = 1
                  AND installation_id = $1
                `,
                [installationId]
              ),
            {
              message:
                "Negative pending inbox count was accepted",
            }
          );

          console.log(
            "✅ 15 Sync-state validation proven"
          );
        }
      );

      await t.test(
        "sync cursors move only forward and identity cannot change",
        async () => {
          await client.query(
            `
            UPDATE public.edge_sync_state
            SET
              sync_status = 'syncing',
              last_acked_outbox_id = 10,
              last_applied_inbox_id = 20,
              updated_at = NOW()
            WHERE
              restaurant_id = 1
              AND installation_id = $1
            `,
            [installationId]
          );

          await client.query(
            `
            UPDATE public.edge_sync_state
            SET
              last_acked_outbox_id = 11,
              last_applied_inbox_id = 21,
              updated_at = NOW()
            WHERE
              restaurant_id = 1
              AND installation_id = $1
            `,
            [installationId]
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_sync_state
                SET last_acked_outbox_id = 9
                WHERE
                  restaurant_id = 1
                  AND installation_id = $1
                `,
                [installationId]
              ),
            {
              message:
                "Outbox cursor moved backwards",
              errorPattern:
                /cannot move backwards/i,
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_sync_state
                SET last_applied_inbox_id = NULL
                WHERE
                  restaurant_id = 1
                  AND installation_id = $1
                `,
                [installationId]
              ),
            {
              message:
                "Inbox cursor was reset",
              errorPattern:
                /cannot move backwards/i,
            }
          );

          await expectReject(
            () =>
              client.query(
                `
                UPDATE public.edge_sync_state
                SET restaurant_id = 2
                WHERE
                  restaurant_id = 1
                  AND installation_id = $1
                `,
                [installationId]
              ),
            {
              message:
                "Sync-state tenant identity changed",
              errorPattern:
                /identity is immutable/i,
            }
          );

          console.log(
            "✅ 16 Sync cursor/identity hardening proven"
          );
        }
      );

      await t.test(
        "orphan restaurant references are rejected",
        async () => {
          await expectReject(
            () =>
              client.query(
                `
                INSERT INTO public.edge_outbox
                (
                  event_id,
                  restaurant_id,
                  event_type,
                  idempotency_key,
                  payload,
                  payload_hash
                )
                VALUES
                (
                  $1,
                  999999999,
                  'attack.orphan',
                  $2,
                  '{}'::jsonb,
                  $3
                )
                `,
                [
                  uuid(),
                  `orphan-${token}`,
                  hash({}),
                ]
              ),
            {
              message:
                "Orphan restaurant Edge event was accepted",
            }
          );

          console.log(
            "✅ 17 Restaurant FK isolation proven"
          );
        }
      );

      console.log("");
      console.log(
        "=============================================="
      );
      console.log(
        "✅ MAKS EDGE SYNC STORAGE ATTACK COMPLETE"
      );
      console.log(
        "=============================================="
      );
    } finally {
      try {
        await client.query(
          "ROLLBACK"
        );
      } finally {
        client.release();
      }
    }

    const afterCounts =
      await pool.query(`
        SELECT
          (SELECT COUNT(*)
           FROM public.edge_outbox)::bigint
            AS outbox,

          (SELECT COUNT(*)
           FROM public.edge_inbox)::bigint
            AS inbox,

          (SELECT COUNT(*)
           FROM public.edge_idempotency)::bigint
            AS idempotency,

          (SELECT COUNT(*)
           FROM public.edge_sync_state)::bigint
            AS sync_state
      `);

    const after =
      afterCounts.rows[0];

    assert.deepEqual(
      after,
      before,
      "Attack left persistent Edge rows behind"
    );

    console.log(
      "✅ 18 Attack transaction rolled back cleanly"
    );

    await pool.end();
  }
);
