// backend/routes/itemsSettingsRoutes.js

const express = require("express");
const router = express.Router();

const {
  authenticateToken,
} = require("../middleware/authMiddleware");

const {
  loadMembership,
} = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
} = require("../middleware/accessControl");

const {
  getItemAvailability,
  normalizeItemType,
  normalizeAvailabilityMode,
} = require("../services/itemsSettingsService");


/* =========================================================
   HELPERS
========================================================= */

const ridOf = (req) =>
  Number(
    req.tenantRid ||
      req.user?.restaurant_id ||
      0
  );


function asBool(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}


function normalizeSettingsPayload(body = {}) {
  const availabilityMode =
    normalizeAvailabilityMode(
      body.availability_mode
    );


  let manualQuantity = null;

  if (
    availabilityMode ===
    "manual"
  ) {
    const raw =
      body.manual_quantity;

    const qty =
      Number(raw);

    if (
      raw === "" ||
      raw === null ||
      raw === undefined ||
      !Number.isInteger(qty) ||
      qty < 0
    ) {
      const err =
        new Error(
          "Manual quantity must be a whole number of 0 or more."
        );

      err.status = 400;
      throw err;
    }

    manualQuantity =
      qty;
  }


  return {
    availability_mode:
      availabilityMode,

    manual_quantity:
      manualQuantity,

    manually_stopped:
      asBool(
        body.manually_stopped
      ),
  };
}


/* =========================================================
   LOAD ALL ITEMS

   GET /items-settings

   Returns:
   - Meals
   - Drinks
   - Desserts

   together in one admin list.

   IMPORTANT:
   This is authenticated staff/admin data.
   It is NOT a public menu endpoint.
========================================================= */

router.get(
  "/",

  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_EDIT
  ),

  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      if (!rid) {
        return res
          .status(400)
          .json({
            error:
              "No restaurant selected.",
          });
      }


      /* ===================================================
         MEALS
      =================================================== */

      const meals =
        await req.qAll(
          `
          SELECT
            id,
            name,
            category,
            category_id,

            availability_mode,
            manual_quantity,
            manually_stopped,
            out_of_stock

          FROM public.meals

          WHERE restaurant_id = $1

          ORDER BY
            LOWER(TRIM(name)) ASC
          `,
          [
            rid,
          ]
        );


      /* ===================================================
         DRINKS + DESSERTS
      =================================================== */

      const menuItems =
        await req.qAll(
          `
          SELECT
            id,
            name,
            type,
            category_id,

            availability_mode,
            manual_quantity,
            manually_stopped,
            out_of_stock

          FROM public.menu_items

          WHERE restaurant_id = $1
            AND LOWER(
              TRIM(
                COALESCE(
                  type,
                  ''
                )
              )
            ) IN (
              'drink',
              'drinks',
              'dessert',
              'desserts'
            )

          ORDER BY
            LOWER(TRIM(name)) ASC
          `,
          [
            rid,
          ]
        );


      const rawItems = [
        ...(meals || []).map(
          (meal) => ({
            ...meal,

            item_type:
              "meal",

            source:
              "meals",
          })
        ),

        ...(menuItems || []).map(
          (item) => {
            const itemType =
              normalizeItemType(
                item.type
              );

            return {
              ...item,

              item_type:
                itemType,

              source:
                "menu_items",
            };
          }
        ),
      ];


      /* ===================================================
         AUTHORITATIVE AVAILABILITY

         We deliberately use itemsSettingsService rather
         than reproducing availability logic here.
      =================================================== */

      const items =
        await Promise.all(
          rawItems.map(
            async (item) => {
              let availability =
                null;

              try {
                availability =
                  await getItemAvailability({
                    db: req,

                    restaurantId:
                      rid,

                    itemType:
                      item.item_type,

                    itemId:
                      item.id,

                    quantity: 1,
                  });
              } catch (err) {
                console.error(
                  "❌ Item availability calculation failed:",
                  {
                    rid,
                    itemId:
                      item.id,

                    itemType:
                      item.item_type,

                    error:
                      err?.message ||
                      err,
                  }
                );
              }


              /*
               * TEMPORARY LEGACY BRIDGE
               *
               * Existing MAKS has out_of_stock.
               * New system has manually_stopped.
               *
               * Until every POS/Kiosk/QR caller has been
               * migrated, display either one as stopped
               * so an existing manually stopped item does
               * not suddenly look available in this page.
               */
              const effectiveStopped =
                asBool(
                  item.manually_stopped
                ) ||
                asBool(
                  item.out_of_stock
                );


              return {
                id:
                  Number(item.id),

                name:
                  String(
                    item.name ||
                      ""
                  ),

                item_type:
                  item.item_type,

                source:
                  item.source,

                category:
                  item.category ||
                  null,

                category_id:
                  item.category_id !=
                  null
                    ? Number(
                        item.category_id
                      )
                    : null,

                availability_mode:
                  normalizeAvailabilityMode(
                    item.availability_mode
                  ),

                manual_quantity:
                  item.manual_quantity !=
                  null
                    ? Number(
                        item.manual_quantity
                      )
                    : null,

                manually_stopped:
                  effectiveStopped,

                legacy_out_of_stock:
                  asBool(
                    item.out_of_stock
                  ),

                can_sell:
                  availability
                    ? !!availability.can_sell
                    : false,

                available_quantity:
                  availability
                    ? availability.available_quantity
                    : null,

                availability_reason:
                  availability
                    ? availability.reason
                    : "AVAILABILITY_ERROR",

                availability_source:
                  availability
                    ? availability.source
                    : "error",
              };
            }
          )
        );


      const counts = {
        total:
          items.length,

        meals:
          items.filter(
            (item) =>
              item.item_type ===
              "meal"
          ).length,

        drinks:
          items.filter(
            (item) =>
              item.item_type ===
              "drink"
          ).length,

        desserts:
          items.filter(
            (item) =>
              item.item_type ===
              "dessert"
          ).length,

        stopped:
          items.filter(
            (item) =>
              item.manually_stopped
          ).length,
      };


      return res.json({
        success: true,
        counts,
        items,
      });
    } catch (err) {
      console.error(
        "❌ GET /items-settings failed:",
        err
      );

      const status =
        Number(
          err?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status < 500
              ? err.message
              : "Failed to load item settings.",
        });
    }
  }
);


/* =========================================================
   UPDATE ONE ITEM

   PUT /items-settings/:type/:id

   type:
   - meal
   - drink
   - dessert

   Body:
   {
     availability_mode:
       "maks" | "manual" | "unlimited",

     manual_quantity:
       number | null,

     manually_stopped:
       boolean
   }
========================================================= */

router.put(
  "/:type/:id",

  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_EDIT
  ),

  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const id =
        Number(
          req.params.id
        );

      const itemType =
        normalizeItemType(
          req.params.type
        );


      if (!rid) {
        return res
          .status(400)
          .json({
            error:
              "No restaurant selected.",
          });
      }


      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid item id.",
          });
      }


      if (!itemType) {
        return res
          .status(400)
          .json({
            error:
              "Item type must be meal, drink or dessert.",
          });
      }


      const settings =
        normalizeSettingsPayload(
          req.body || {}
        );


      let updated =
        null;


      /* ===================================================
         MEAL
      =================================================== */

      if (
  itemType ===
  "meal"
) {
  updated =
    await req.qGet(
      `
      UPDATE public.meals

      SET
        availability_mode = $1,
        manual_quantity = $2,
        manually_stopped = $3,
        out_of_stock = $3

      WHERE restaurant_id = $4
        AND id = $5

      RETURNING
        id,
        name,
        availability_mode,
        manual_quantity,
        manually_stopped,
        out_of_stock
      `,
      [
        settings.availability_mode,
        settings.manual_quantity,
        settings.manually_stopped,
        rid,
        id,
      ]
    );
}


      /* ===================================================
         DRINK / DESSERT
      =================================================== */

      if (
  itemType === "drink" ||
  itemType === "dessert"
) {
  updated =
    await req.qGet(
      `
      UPDATE public.menu_items

      SET
        availability_mode = $1,
        manual_quantity = $2,
        manually_stopped = $3,
        out_of_stock = $3

      WHERE restaurant_id = $4
        AND id = $5
        AND LOWER(
          TRIM(
            COALESCE(
              type,
              ''
            )
          )
        ) IN (
          $6,
          $7
        )

      RETURNING
        id,
        name,
        type,
        availability_mode,
        manual_quantity,
        manually_stopped,
        out_of_stock
      `,
      [
        settings.availability_mode,
        settings.manual_quantity,
        settings.manually_stopped,
        rid,
        id,
        itemType,
        `${itemType}s`,
      ]
    );
}


      if (!updated?.id) {
        return res
          .status(404)
          .json({
            error:
              "Item not found.",
          });
      }


      const availability =
        await getItemAvailability({
          db: req,

          restaurantId:
            rid,

          itemType,

          itemId:
            id,

          quantity: 1,
        });


      return res.json({
        success: true,

        item: {
          id:
            Number(
              updated.id
            ),

          name:
            updated.name,

          item_type:
            itemType,

          availability_mode:
            normalizeAvailabilityMode(
              updated.availability_mode
            ),

          manual_quantity:
            updated.manual_quantity !=
            null
              ? Number(
                  updated.manual_quantity
                )
              : null,

          manually_stopped:
            asBool(
              updated.manually_stopped
            ),

          can_sell:
            !!availability.can_sell,

          available_quantity:
            availability.available_quantity,

          availability_reason:
            availability.reason,

          availability_source:
            availability.source,
        },
      });
    } catch (err) {
      console.error(
        "❌ PUT /items-settings failed:",
        err
      );

      const status =
        Number(
          err?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status < 500
              ? err.message
              : "Failed to update item settings.",
        });
    }
  }
);


module.exports =
  router;