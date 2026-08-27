"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const {
  Pool,
} = require("pg");

const {
  withTx,
} = require(
  "../../dbCompat"
);

const {
  runCanonicalCommercialPricingPg,
} = require(
  "../../migrations/canonicalCommercialPricing.pg"
);

const {
  runCanonicalEdgeSyncFoundationPg,
} = require(
  "../../migrations/canonicalEdgeSyncFoundation.pg"
);

const {
  runCanonicalEdgeDomainRevisionsPg,
} = require(
  "../../migrations/canonicalEdgeDomainRevisions.pg"
);

const {
  EdgeDomainRevisionError,
  readDomainRevisionTx,
} = require(
  "../../edge/domainRevisionStore"
);

const {
  receiveInboxEvent,
} = require(
  "../../edge/syncStore"
);

const {
  applyInboxOnce,
} = require(
  "../../edge/applyEngine"
);

const {
  PROMOTIONS_DOMAIN,
  PROMOTIONS_EVENT_TYPE,
  PromotionsContractError,
  validatePromotionsPayload,
  emitPromotionsSnapshotTx,
  applyPromotionsReplaced,
} = require(
  "../../edge/contracts/promotions"
);


const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
    ""
  ).trim();


function uuid() {
  return crypto.randomUUID();
}


function hashPayload(
  payload
) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(payload)
    )
    .digest("hex");
}


async function insertPromotion(
  tx,
  restaurantId,
  {
    title,
    priority = 0,
    imageUrl = null,
    active = true,
    showOnQr = true,
    showOnKiosk = true,
    showOnEatIn = true,
    showOnTakeaway = true,
    showForDineIn = true,
    showForTakeaway = true,
    promotionType = "advert",
    buttonText = "View Menu",
    buttonAction = "none",
    actionType = "none",
    actionTarget = null,
    linkedCategoryId = null,
    linkedItemId = null,
    mealPeriod = "all",
    daysOfWeek = ["mon", "fri"],
    sortOrder = 0,
    startDate = null,
    endDate = null,
    startTime = null,
    endTime = null,
    eventDate = null,
    eventTime = null,
    eventEndTime = null,
  } = {}
) {
  return tx.qGet(
    `
    INSERT INTO
      public.restaurant_promotions
    (
      restaurant_id,
      title,
      description,
      image_url,
      display_context,
      order_type,
      linked_item_id,
      linked_item_type,
      active,
      created_at,
      updated_at,
      show_on_qr,
      show_on_kiosk,
      show_on_eat_in,
      show_on_takeaway,
      show_for_dine_in,
      show_for_takeaway,
      button_text,
      action_type,
      action_target,
      start_at,
      end_at,
      sort_order,
      promotion_type,
      button_action,
      linked_category_id,
      start_date,
      end_date,
      start_time,
      end_time,
      meal_period,
      days_of_week,
      priority,
      event_date,
      event_time,
      event_end_time
    )
    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      'both',
      'both',
      $5,
      CASE
        WHEN $5::bigint IS NULL
          THEN NULL
        ELSE 'item'
      END,
      $6,
      NOW(),
      NOW(),
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      NULL,
      NULL,
      $16,
      $17,
      $18,
      $19,
      $20,
      $21,
      $22,
      $23,
      $24,
      $25::jsonb,
      $26,
      $27,
      $28,
      $29
    )
    RETURNING *
    `,
    [
      restaurantId,
      title,
      `Description for ${title}`,
      imageUrl,
      linkedItemId,
      active,
      showOnQr,
      showOnKiosk,
      showOnEatIn,
      showOnTakeaway,
      showForDineIn,
      showForTakeaway,
      buttonText,
      actionType,
      actionTarget,
      sortOrder,
      promotionType,
      buttonAction,
      linkedCategoryId,
      startDate,
      endDate,
      startTime,
      endTime,
      mealPeriod,
      JSON.stringify(
        daysOfWeek
      ),
      priority,
      eventDate,
      eventTime,
      eventEndTime,
    ]
  );
}


async function promotionRows(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        title,
        description,
        image_url,
        display_context,
        order_type,
        linked_item_id,
        linked_item_type,
        active,
        created_at,
        updated_at,
        show_on_qr,
        show_on_kiosk,
        show_on_eat_in,
        show_on_takeaway,
        show_for_dine_in,
        show_for_takeaway,
        button_text,
        action_type,
        action_target,
        start_at,
        end_at,
        sort_order,
        promotion_type,
        button_action,
        linked_category_id,
        start_date,
        end_date,
        start_time,
        end_time,
        meal_period,
        days_of_week,
        priority,
        event_date,
        event_time,
        event_end_time
      FROM
        public.restaurant_promotions
      WHERE
        restaurant_id = $1
      ORDER BY
        priority DESC,
        sort_order ASC,
        id DESC
      `,
      [
        restaurantId,
      ]
    );

  return result.rows;
}


async function producedState(
  restaurantId
) {
  return withTx(
    (tx) =>
      readDomainRevisionTx(
        tx,
        {
          restaurantId,
          domain:
            PROMOTIONS_DOMAIN,
        }
      )
  );
}


async function outboxCount(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        COUNT(*)::int
          AS count
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND event_type = $2
      `,
      [
        restaurantId,
        PROMOTIONS_EVENT_TYPE,
      ]
    );

  return Number(
    result.rows?.[0]?.count ||
    0
  );
}


async function expectCode(
  fn,
  code
) {
  let caught =
    null;

  try {
    await fn();
  } catch (error) {
    caught =
      error;
  }

  assert.ok(
    caught,
    `Expected error ${code}`
  );

  assert.equal(
    caught.code,
    code
  );

  return caught;
}


test(
  "MAKS Cloud to Edge promotions contract attack",
  {
    timeout:
      60000,
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

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    const originalRole =
      process.env
        .MAKS_RUNTIME_ROLE;

    let restaurantA =
      null;

    let restaurantB =
      null;

    let revision2 =
      null;

    try {
      const database =
        await pool.query(
          "SELECT current_database() AS db"
        );

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: promotions contract Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );

      await runCanonicalCommercialPricingPg({
        pool,
      });

      await runCanonicalEdgeSyncFoundationPg({
        pool,
      });

      await runCanonicalEdgeDomainRevisionsPg({
        pool,
      });

      console.log(
        "✅ 02 Required canonical schemas verified"
      );

      const ra =
        await pool.query(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `PROMOTIONS CONTRACT ATTACK A ${token}`,
          ]
        );

      const rb =
        await pool.query(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `PROMOTIONS CONTRACT ATTACK B ${token}`,
          ]
        );

      restaurantA =
        Number(
          ra.rows[0].id
        );

      restaurantB =
        Number(
          rb.rows[0].id
        );

      await withTx(
        async (tx) => {
          await insertPromotion(
            tx,
            restaurantA,
            {
              title:
                `A BASE ${token}`,

              priority:
                10,

              imageUrl:
                `/uploads/${restaurantA}/promotions/base.jpg`,
            }
          );

          await insertPromotion(
            tx,
            restaurantB,
            {
              title:
                `B KEEP ${token}`,

              priority:
                20,
            }
          );
        }
      );

      console.log(
        "✅ 03 Isolated promotion tenants created"
      );


      await t.test(
        "Cloud producer emits a strict full promotion snapshot with revision 1",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const produced =
            await withTx(
              (tx) =>
                emitPromotionsSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                )
            );

          assert.equal(
            produced.revision,
            1
          );

          assert.equal(
            produced.payload
              .schema_version,
            1
          );

          assert.equal(
            produced.payload
              .revision,
            1
          );

          assert.equal(
            produced.payload
              .promotions
              .length,
            1
          );

          assert.equal(
            produced.payload
              .promotions[0]
              .title,
            `A BASE ${token}`
          );

          assert.equal(
            produced.payload
              .promotions[0]
              .image_url,
            `/uploads/${restaurantA}/promotions/base.jpg`
          );

          assert.equal(
            produced.event
              .event_type,
            PROMOTIONS_EVENT_TYPE
          );

          assert.equal(
            produced.event
              .idempotency_key,
            `${PROMOTIONS_EVENT_TYPE}:1`
          );

          assert.deepEqual(
            validatePromotionsPayload(
              produced.payload
            ),
            produced.payload
          );

          assert.equal(
            await outboxCount(
              pool,
              restaurantA
            ),
            1
          );

          console.log(
            "✅ 04 Cloud promotion snapshot production proven"
          );
        }
      );


      await t.test(
        "promotion mutation revision and outbox roll back together",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const beforeRows =
            await promotionRows(
              pool,
              restaurantA
            );

          const beforeRevision =
            await producedState(
              restaurantA
            );

          const beforeOutbox =
            await outboxCount(
              pool,
              restaurantA
            );

          await assert.rejects(
            () =>
              withTx(
                async (tx) => {
                  await insertPromotion(
                    tx,
                    restaurantA,
                    {
                      title:
                        `SHOULD ROLL BACK ${token}`,

                      priority:
                        99,
                    }
                  );

                  await emitPromotionsSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  );

                  throw new Error(
                    "simulated promotion producer crash"
                  );
                }
              ),
            /simulated promotion producer crash/
          );

          const afterRows =
            await promotionRows(
              pool,
              restaurantA
            );

          const afterRevision =
            await producedState(
              restaurantA
            );

          const afterOutbox =
            await outboxCount(
              pool,
              restaurantA
            );

          assert.deepEqual(
            afterRows.map(
              (row) =>
                String(row.title)
            ),
            beforeRows.map(
              (row) =>
                String(row.title)
            )
          );

          assert.equal(
            Number(
              afterRevision
                .produced_revision
            ),
            Number(
              beforeRevision
                .produced_revision
            )
          );

          assert.equal(
            afterOutbox,
            beforeOutbox
          );

          console.log(
            "✅ 05 Atomic promotion mutation + revision + outbox rollback proven"
          );
        }
      );


      await t.test(
        "Edge and missing runtime roles cannot produce Cloud promotion snapshots",
        async () => {
          const before =
            await producedState(
              restaurantA
            );

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          await expectCode(
            () =>
              withTx(
                (tx) =>
                  emitPromotionsSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  )
              ),
            "MAKS_RUNTIME_ROLE_NOT_CLOUD"
          );

          delete process.env
            .MAKS_RUNTIME_ROLE;

          await expectCode(
            () =>
              withTx(
                (tx) =>
                  emitPromotionsSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  )
              ),
            "MAKS_RUNTIME_ROLE_MISSING"
          );

          const after =
            await producedState(
              restaurantA
            );

          assert.equal(
            Number(
              after.produced_revision
            ),
            Number(
              before.produced_revision
            )
          );

          console.log(
            "✅ 06 Cloud-only promotion producer authority proven"
          );
        }
      );


      await t.test(
        "newer snapshot replaces the full modern field set for only its tenant",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          revision2 =
            await withTx(
              async (tx) => {
                const existing =
                  await tx.qGet(
                    `
                    SELECT id
                    FROM
                      public.restaurant_promotions
                    WHERE
                      restaurant_id = $1
                    ORDER BY
                      id ASC
                    LIMIT 1
                    `,
                    [
                      restaurantA,
                    ]
                  );

                assert.ok(
                  existing?.id
                );

                await tx.qRun(
                  `
                  UPDATE
                    public.restaurant_promotions
                  SET
                    title = $2,
                    description = $3,
                    image_url = $4,
                    display_context = 'qr',
                    order_type = 'dine-in',
                    active = FALSE,
                    show_on_qr = TRUE,
                    show_on_kiosk = FALSE,
                    show_on_eat_in = FALSE,
                    show_on_takeaway = TRUE,
                    show_for_dine_in = TRUE,
                    show_for_takeaway = FALSE,
                    button_text = 'Book Now',
                    action_type = 'booking',
                    action_target = 'event',
                    sort_order = 7,
                    promotion_type = 'booking_event',
                    button_action = 'booking',
                    start_date = '2026-09-01',
                    end_date = '2026-09-30',
                    start_time = '12:30',
                    end_time = '22:15',
                    meal_period = 'dinner',
                    days_of_week =
                      '["tue","sat"]'::jsonb,
                    priority = 88,
                    event_date = '2026-09-20',
                    event_time = '18:45',
                    event_end_time = '21:00',
                    updated_at = NOW()
                  WHERE
                    id = $1
                    AND restaurant_id = $5
                  `,
                  [
                    existing.id,
                    `A MODERN ${token}`,
                    `Modern promotion ${token}`,
                    `/uploads/${restaurantA}/promotions/modern.jpg`,
                    restaurantA,
                  ]
                );

                await insertPromotion(
                  tx,
                  restaurantA,
                  {
                    title:
                      `A SECOND ${token}`,

                    priority:
                      30,

                    promotionType:
                      "advert",

                    daysOfWeek:
                      [
                        "wed",
                      ],
                  }
                );

                return emitPromotionsSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                );
              }
            );

          assert.equal(
            revision2.revision,
            2
          );

          assert.equal(
            revision2.payload
              .promotions.length,
            2
          );

          const modern =
            revision2.payload
              .promotions
              .find(
                (row) =>
                  row.title ===
                    `A MODERN ${token}`
              );

          assert.ok(
            modern,
            "Modern promotion missing from revision 2 snapshot"
          );

          assert.equal(
            modern.active,
            false
          );

          assert.equal(
            modern.show_on_qr,
            true
          );

          assert.equal(
            modern.show_on_kiosk,
            false
          );

          assert.equal(
            modern.show_on_eat_in,
            false
          );

          assert.equal(
            modern.show_on_takeaway,
            true
          );

          assert.equal(
            modern.show_for_dine_in,
            true
          );

          assert.equal(
            modern.show_for_takeaway,
            false
          );

          assert.equal(
            modern.promotion_type,
            "booking_event"
          );

          assert.equal(
            modern.button_action,
            "booking"
          );

          assert.equal(
            modern.meal_period,
            "dinner"
          );

          assert.deepEqual(
            modern.days_of_week,
            [
              "tue",
              "sat",
            ]
          );

          assert.equal(
            modern.priority,
            88
          );

          const tenantBBefore =
            await promotionRows(
              pool,
              restaurantB
            );

          await pool.query(
            `
            UPDATE
              public.restaurant_promotions
            SET
              title = $2,
              priority = -100
            WHERE
              restaurant_id = $1
            `,
            [
              restaurantA,
              `LOCAL STALE ${token}`,
            ]
          );

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          const applied =
            await withTx(
              (tx) =>
                applyPromotionsReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    revision2.event,

                  payload:
                    revision2.payload,
                })
            );

          assert.equal(
            applied.state,
            "applied"
          );

          assert.equal(
            applied.appliedRevision,
            2
          );

          const tenantAAfter =
            await promotionRows(
              pool,
              restaurantA
            );

          assert.equal(
            tenantAAfter.length,
            2
          );

          assert.ok(
            tenantAAfter.some(
              (row) =>
                row.title ===
                  `A MODERN ${token}`
            )
          );

          assert.ok(
            tenantAAfter.some(
              (row) =>
                row.title ===
                  `A SECOND ${token}`
            )
          );

          const restoredModern =
            tenantAAfter.find(
              (row) =>
                row.title ===
                  `A MODERN ${token}`
            );

          assert.equal(
            restoredModern
              .show_on_kiosk,
            false
          );

          assert.equal(
            restoredModern
              .button_action,
            "booking"
          );

          assert.equal(
            restoredModern
              .priority,
            88
          );

          assert.deepEqual(
            restoredModern
              .days_of_week,
            [
              "tue",
              "sat",
            ]
          );

          const tenantBAfter =
            await promotionRows(
              pool,
              restaurantB
            );

          assert.deepEqual(
            tenantBAfter.map(
              (row) => ({
                id:
                  String(row.id),

                title:
                  row.title,

                priority:
                  row.priority,
              })
            ),
            tenantBBefore.map(
              (row) => ({
                id:
                  String(row.id),

                title:
                  row.title,

                priority:
                  row.priority,
              })
            )
          );

          console.log(
            "✅ 07 Tenant-safe full modern promotion replacement proven"
          );
        }
      );


      await t.test(
        "stale duplicate and conflicting promotion revisions fail safely",
        async () => {
          assert.ok(
            revision2
          );

          const before =
            await promotionRows(
              pool,
              restaurantA
            );

          const stalePayload = {
            ...revision2.payload,
            revision:
              1,
          };

          const stale =
            await withTx(
              (tx) =>
                applyPromotionsReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event: {
                    ...revision2.event,

                    payload_hash:
                      hashPayload(
                        stalePayload
                      ),
                  },

                  payload:
                    stalePayload,
                })
            );

          assert.equal(
            stale.state,
            "stale"
          );

          const duplicate =
            await withTx(
              (tx) =>
                applyPromotionsReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    revision2.event,

                  payload:
                    revision2.payload,
                })
            );

          assert.equal(
            duplicate.state,
            "duplicate"
          );

          let conflict =
            null;

          try {
            await withTx(
              (tx) =>
                applyPromotionsReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event: {
                    ...revision2.event,

                    payload_hash:
                      "f".repeat(64),
                  },

                  payload:
                    revision2.payload,
                })
            );
          } catch (error) {
            conflict =
              error;
          }

          assert.ok(
            conflict instanceof
              EdgeDomainRevisionError
          );

          assert.equal(
            conflict.code,
            "EDGE_DOMAIN_REVISION_CONFLICT"
          );

          const after =
            await promotionRows(
              pool,
              restaurantA
            );

          assert.deepEqual(
            after.map(
              (row) => ({
                id:
                  String(row.id),

                title:
                  row.title,

                priority:
                  row.priority,
              })
            ),
            before.map(
              (row) => ({
                id:
                  String(row.id),

                title:
                  row.title,

                priority:
                  row.priority,
              })
            )
          );

          console.log(
            "✅ 08 Promotion stale/replay/conflict protection proven"
          );
        }
      );


      await t.test(
        "strict malformed promotion payload is rejected before business mutation",
        async () => {
          const before =
            await promotionRows(
              pool,
              restaurantA
            );

          const badPayload = {
            ...revision2.payload,

            promotions:
              revision2.payload
                .promotions.map(
                  (row, index) =>
                    index === 0
                      ? {
                          ...row,

                          cross_tenant_attack:
                            true,
                        }
                      : row
                ),
          };

          let error =
            null;

          try {
            validatePromotionsPayload(
              badPayload
            );
          } catch (caught) {
            error =
              caught;
          }

          assert.ok(
            error instanceof
              PromotionsContractError
          );

          assert.equal(
            error.code,
            "PROMOTIONS_SYNC_PAYLOAD_INVALID"
          );

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  applyPromotionsReplaced({
                    tx,

                    restaurantId:
                      restaurantA,

                    event: {
                      ...revision2.event,

                      payload_hash:
                        hashPayload(
                          badPayload
                        ),
                    },

                    payload:
                      badPayload,
                  })
              ),
            (caught) =>
              caught instanceof
                PromotionsContractError &&
              caught.code ===
                "PROMOTIONS_SYNC_PAYLOAD_INVALID"
          );

          const after =
            await promotionRows(
              pool,
              restaurantA
            );

          assert.deepEqual(
            after.map(
              (row) =>
                String(row.id)
            ),
            before.map(
              (row) =>
                String(row.id)
            )
          );

          console.log(
            "✅ 09 Strict promotion payload validation proven"
          );
        }
      );


      await t.test(
        "empty authoritative snapshot deletes only the target tenant promotions",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const revision3 =
            await withTx(
              async (tx) => {
                await tx.qRun(
                  `
                  DELETE FROM
                    public.restaurant_promotions
                  WHERE
                    restaurant_id = $1
                  `,
                  [
                    restaurantA,
                  ]
                );

                return emitPromotionsSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                );
              }
            );

          assert.equal(
            revision3.revision,
            3
          );

          assert.deepEqual(
            revision3.payload
              .promotions,
            []
          );

          const tenantBBefore =
            await promotionRows(
              pool,
              restaurantB
            );

          await withTx(
            (tx) =>
              insertPromotion(
                tx,
                restaurantA,
                {
                  title:
                    `LOCAL SHOULD DELETE ${token}`,

                  priority:
                    999,
                }
              )
          );

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          const applied =
            await withTx(
              (tx) =>
                applyPromotionsReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    revision3.event,

                  payload:
                    revision3.payload,
                })
            );

          assert.equal(
            applied.state,
            "applied"
          );

          assert.equal(
            (
              await promotionRows(
                pool,
                restaurantA
              )
            ).length,
            0
          );

          const tenantBAfter =
            await promotionRows(
              pool,
              restaurantB
            );

          assert.deepEqual(
            tenantBAfter.map(
              (row) =>
                String(row.id)
            ),
            tenantBBefore.map(
              (row) =>
                String(row.id)
            )
          );

          console.log(
            "✅ 10 Authoritative promotion deletion + tenant isolation proven"
          );
        }
      );


      await t.test(
        "production application engine applies the promotions handler exactly once",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const revision4 =
            await withTx(
              async (tx) => {
                await insertPromotion(
                  tx,
                  restaurantA,
                  {
                    title:
                      `ENGINE APPLY ${token}`,

                    priority:
                      45,

                    imageUrl:
                      `/uploads/${restaurantA}/promotions/engine.jpg`,

                    showOnKiosk:
                      false,

                    promotionType:
                      "advert",

                    daysOfWeek:
                      [
                        "sun",
                      ],
                  }
                );

                return emitPromotionsSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                );
              }
            );

          assert.equal(
            revision4.revision,
            4
          );

          await pool.query(
            `
            DELETE FROM
              public.restaurant_promotions
            WHERE
              restaurant_id = $1
            `,
            [
              restaurantA,
            ]
          );

          const inboxEventId =
            uuid();

          await receiveInboxEvent({
            eventId:
              inboxEventId,

            restaurantId:
              restaurantA,

            source:
              "cloud",

            eventType:
              PROMOTIONS_EVENT_TYPE,

            entityType:
              "restaurant_promotions",

            entityId:
              String(
                restaurantA
              ),

            payload:
              revision4.payload,

            pool,
          });

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          const first =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `promotions-worker-${token}`,

              handlers: {
                [PROMOTIONS_EVENT_TYPE]:
                  applyPromotionsReplaced,
              },

              limit:
                10,

              leaseSeconds:
                30,

              maxAttempts:
                5,
            });

          assert.equal(
            first.applied,
            1
          );

          const rows =
            await promotionRows(
              pool,
              restaurantA
            );

          assert.equal(
            rows.length,
            1
          );

          assert.equal(
            rows[0].title,
            `ENGINE APPLY ${token}`
          );

          assert.equal(
            rows[0]
              .show_on_kiosk,
            false
          );

          assert.deepEqual(
            rows[0]
              .days_of_week,
            [
              "sun",
            ]
          );

          const second =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `promotions-worker-2-${token}`,

              handlers: {
                [PROMOTIONS_EVENT_TYPE]:
                  applyPromotionsReplaced,
              },

              limit:
                10,

              leaseSeconds:
                30,

              maxAttempts:
                5,
            });

          assert.equal(
            second.applied,
            0
          );

          const inbox =
            await pool.query(
              `
              SELECT
                status,
                apply_attempts
              FROM
                public.edge_inbox
              WHERE
                restaurant_id = $1
                AND event_id = $2
              `,
              [
                restaurantA,
                inboxEventId,
              ]
            );

          assert.equal(
            inbox.rows.length,
            1
          );

          assert.equal(
            inbox.rows[0].status,
            "applied"
          );

          assert.equal(
            Number(
              inbox.rows[0]
                .apply_attempts
            ),
            1
          );

          console.log(
            "✅ 11 Production promotions handler + application engine proven"
          );
        }
      );


      console.log(
        ""
      );

      console.log(
        "============================================"
      );

      console.log(
        "✅ MAKS EDGE PROMOTIONS CONTRACT ATTACK COMPLETE"
      );

      console.log(
        "============================================"
      );
    } finally {
      if (
        originalRole ===
          undefined
      ) {
        delete process.env
          .MAKS_RUNTIME_ROLE;
      } else {
        process.env.MAKS_RUNTIME_ROLE =
          originalRole;
      }

      if (
        restaurantA ||
        restaurantB
      ) {
        await pool.query(
          `
          DELETE FROM
            public.restaurants
          WHERE
            id =
              ANY(
                $1::bigint[]
              )
          `,
          [
            [
              restaurantA,
              restaurantB,
            ].filter(
              Boolean
            ),
          ]
        );

        const leaked =
          await pool.query(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_domain_revisions
            WHERE
              restaurant_id =
                ANY(
                  $1::bigint[]
                )
            `,
            [
              [
                restaurantA,
                restaurantB,
              ].filter(
                Boolean
              ),
            ]
          );

        assert.equal(
          Number(
            leaked.rows?.[0]?.count ||
            0
          ),
          0,
          "Promotion domain revision rows leaked after tenant cleanup"
        );
      }

      await pool.end();

      console.log(
        "✅ 12 Cleanup proven"
      );
    }
  }
);
