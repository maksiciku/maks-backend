"use strict";

const router =
  require("express").Router();

const {
  withTx,
} = require(
  "../dbCompat"
);

const {
  MaksRuntimeRoleError,
  assertCloudRuntime,
} = require(
  "../utils/runtimeRole"
);

const {
  emitMenuCatalogSnapshotTx,
} = require(
  "../edge/contracts/menuCatalog"
);


const ridOf =
  (req) =>
    Number(
      req.tenantRid ||
      0
    );


function bind(
  sqliteSql,
  pgSql,
  kind
) {
  return kind ===
    "pg"
    ? pgSql
    : sqliteSql;
}


const normType =
  (t) => {
    const s =
      String(
        t || ""
      )
        .toLowerCase()
        .trim();

    if (
      s.startsWith(
        "drink"
      )
    ) {
      return "drinks";
    }

    if (
      s.startsWith(
        "dessert"
      )
    ) {
      return "desserts";
    }

    return "meals";
  };


function sendCategoryAuthorityError(
  res,
  error
) {
  if (
    !(
      error instanceof
        MaksRuntimeRoleError
    )
  ) {
    return false;
  }

  if (
    error.code ===
      "MAKS_RUNTIME_ROLE_NOT_CLOUD"
  ) {
    res.status(409).json({
      error:
        "Menu category changes must be made through MAKS Cloud.",

      code:
        "MENU_CATALOG_CLOUD_AUTHORITY_REQUIRED",
    });

    return true;
  }

  res.status(503).json({
    error:
      "Menu category changes are temporarily unavailable because the MAKS runtime role is not configured correctly.",

    code:
      "MENU_CATALOG_RUNTIME_ROLE_UNAVAILABLE",
  });

  return true;
}


function requireCloudCategoryAuthority(
  req,
  res,
  next
) {
  try {
    assertCloudRuntime();

    return next();
  } catch (
    error
  ) {
    if (
      sendCategoryAuthorityError(
        res,
        error
      )
    ) {
      return;
    }

    return next(
      error
    );
  }
}


// GET /categories?type=meals|drinks|desserts
router.get(
  "/",
  async (
    req,
    res
  ) => {
    try {
      const rid =
        ridOf(
          req
        );

      if (
        !rid
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing rid",
          });
      }

      const tp =
        req.query.type
          ? normType(
              req.query.type
            )
          : null;

      const rows =
        await req.qAll(
          `
          SELECT
            id,
            restaurant_id,
            name,
            type,
            COALESCE(
              icon,
              '🍽️'
            ) AS icon
          FROM
            categories
          WHERE
            restaurant_id = ?
            ${
              tp
                ? "AND type = ?"
                : ""
            }
          ORDER BY
            name ASC
          `,
          tp
            ? [
                rid,
                tp,
              ]
            : [
                rid,
              ]
        );

      return res.json(
        rows ||
        []
      );
    } catch (
      error
    ) {
      console.error(
        "categories GET error",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to load categories",
        });
    }
  }
);


// POST /categories  { name, type, icon }
router.post(
  "/",
  requireCloudCategoryAuthority,
  async (
    req,
    res
  ) => {
    try {
      const rid =
        ridOf(
          req
        );

      if (
        !rid
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing rid",
          });
      }

      const {
        name,
        type,
        icon,
      } =
        req.body ||
        {};

      const nm =
        String(
          name ||
          ""
        ).trim();

      if (
        !nm
      ) {
        return res
          .status(400)
          .json({
            error:
              "Name required",
          });
      }

      const tp =
        normType(
          type
        );

      const ic =
        String(
          icon ||
          "🍽️"
        ).trim() ||
        "🍽️";

      const row =
        await withTx(
          async (
            tx
          ) => {
            const saved =
              await tx.qGet(
                `
                INSERT INTO
                  public.categories
                (
                  restaurant_id,
                  name,
                  type,
                  icon
                )
                VALUES
                (
                  $1,
                  $2,
                  $3,
                  $4
                )
                ON CONFLICT
                  (
                    restaurant_id,
                    name
                  )
                DO UPDATE
                SET
                  type =
                    EXCLUDED.type,

                  icon =
                    EXCLUDED.icon
                RETURNING
                  id,
                  name,
                  type,
                  icon
                `,
                [
                  rid,
                  nm,
                  tp,
                  ic,
                ]
              );

            await emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );

            return saved;
          }
        );

      return res.json(
        row
      );
    } catch (
      error
    ) {
      if (
        sendCategoryAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "categories POST error",
        error
      );

      if (
        error?.code ===
          "23505" ||
        String(
          error?.message ||
          ""
        )
          .toLowerCase()
          .includes(
            "unique"
          )
      ) {
        return res
          .status(409)
          .json({
            error:
              "Category already exists",
          });
      }

      return res
        .status(500)
        .json({
          error:
            "Failed to create category",
        });
    }
  }
);


// DELETE /categories/:id
router.delete(
  "/:id",
  requireCloudCategoryAuthority,
  async (
    req,
    res
  ) => {
    try {
      const rid =
        ridOf(
          req
        );

      if (
        !rid
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing rid",
          });
      }

      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isSafeInteger(
          id
        ) ||
        id <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid id",
          });
      }

      await withTx(
        async (
          tx
        ) => {
          const deleted =
            await tx.qGet(
              `
              DELETE FROM
                public.categories
              WHERE
                id = $1
                AND restaurant_id = $2
              RETURNING
                id
              `,
              [
                id,
                rid,
              ]
            );

          if (
            deleted?.id
          ) {
            await emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );
          }

          return deleted;
        }
      );

      return res.json({
        success:
          true,
      });
    } catch (
      error
    ) {
      if (
        sendCategoryAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "categories DELETE error",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to delete category",
        });
    }
  }
);


module.exports =
  router;
