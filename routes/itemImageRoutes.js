const fs = require("fs");

const router = require("express").Router();

const {
  authenticateToken,
} = require("../middleware/authMiddleware");

const {
  loadMembership,
} = require("../middleware/tenantMembership");

const {
  uploadMenuItemImage,
} = require("../utils/uploads");

const {
  withTx,
} = require("../dbCompat");

const {
  emitMenuCatalogSnapshotTx,
} = require("../edge/contracts/menuCatalog");

const {
  MaksRuntimeRoleError,
  assertCloudRuntime,
} = require("../utils/runtimeRole");

function ridOf(req) {
  return Number(
    req.tenantRid ||
      req.user?.restaurant_id ||
      0
  );
}

function normalizeImageType(raw) {
  const type =
    String(raw || "")
      .trim()
      .toLowerCase();

  if (
    type === "meal" ||
    type === "meals"
  ) {
    return "meal";
  }

  if (
    type === "drink" ||
    type === "drinks"
  ) {
    return "drink";
  }

  if (
    type === "dessert" ||
    type === "desserts"
  ) {
    return "dessert";
  }

  return null;
}

function sendMenuCatalogAuthorityError(
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
        "MENU_CATALOG_CLOUD_AUTHORITY_REQUIRED",
    });

    return true;
  }

  res.status(503).json({
    error:
      "MENU_CATALOG_RUNTIME_ROLE_UNAVAILABLE",
  });

  return true;
}

function requireCloudMenuCatalogAuthority(
  req,
  res,
  next
) {
  try {
    assertCloudRuntime();
    next();
  } catch (error) {
    if (
      sendMenuCatalogAuthorityError(
        res,
        error
      )
    ) {
      return;
    }

    next(error);
  }
}

async function requireOwnedImageTarget(
  req,
  res,
  next
) {
  try {
    const rid =
      ridOf(req);

    const id =
      Number(
        req.params.id ||
        0
      );

    const itemType =
      normalizeImageType(
        req.params.type
      );

    if (!rid) {
      return res
        .status(401)
        .json({
          error:
            "Missing tenant",
        });
    }

    if (!id) {
      return res
        .status(400)
        .json({
          error:
            "Invalid item id",
        });
    }

    if (!itemType) {
      return res
        .status(400)
        .json({
          error:
            "Invalid item type",
        });
    }

    let target =
      null;

    if (
      itemType ===
      "meal"
    ) {
      target =
        await req.qGet(
          `
          SELECT id
          FROM public.meals
          WHERE restaurant_id = $1
            AND id = $2
          LIMIT 1
          `,
          [
            rid,
            id,
          ]
        );
    } else {
      target =
        await req.qGet(
          `
          SELECT id
          FROM public.menu_items
          WHERE restaurant_id = $1
            AND id = $2
            AND LOWER(
              TRIM(type)
            ) IN (
              $3,
              $4
            )
          LIMIT 1
          `,
          [
            rid,
            id,
            itemType,
            `${itemType}s`,
          ]
        );
    }

    if (!target?.id) {
      return res
        .status(404)
        .json({
          error:
            "Item not found",
        });
    }

    req.menuImageTarget = {
      rid,
      id,
      itemType,
    };

    return next();
  } catch (error) {
    console.error(
      "❌ item image target check failed:",
      error
    );

    return res
      .status(500)
      .json({
        error:
          "Failed to validate item image target",
      });
  }
}

async function cleanupUploadedFile(
  file
) {
  const filePath =
    String(
      file?.path ||
      ""
    ).trim();

  if (!filePath) {
    return;
  }

  try {
    await fs.promises.unlink(
      filePath
    );
  } catch (error) {
    if (
      error?.code !==
      "ENOENT"
    ) {
      console.error(
        "⚠️ failed to clean uploaded menu image:",
        error
      );
    }
  }
}

router.post(
  "/:type/:id/image",

  authenticateToken,
  loadMembership,

  requireCloudMenuCatalogAuthority,

  requireOwnedImageTarget,

  uploadMenuItemImage.single(
    "photo"
  ),

  async (req, res) => {
    try {
      const {
        rid,
        id,
        itemType,
      } =
        req.menuImageTarget ||
        {};

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              "No photo uploaded",
          });
      }

      const imageUrl =
        `/uploads/${rid}/menu-items/${req.file.filename}`;

      const updated =
        await withTx(
          async (tx) => {
            let row =
              null;

            if (
              itemType ===
              "meal"
            ) {
              row =
                await tx.qGet(
                  `
                  UPDATE public.meals
                  SET photo_url = $1
                  WHERE restaurant_id = $2
                    AND id = $3
                  RETURNING id
                  `,
                  [
                    imageUrl,
                    rid,
                    id,
                  ]
                );
            } else {
              row =
                await tx.qGet(
                  `
                  UPDATE public.menu_items
                  SET photo_url = $1
                  WHERE restaurant_id = $2
                    AND id = $3
                    AND LOWER(
                      TRIM(type)
                    ) IN (
                      $4,
                      $5
                    )
                  RETURNING id
                  `,
                  [
                    imageUrl,
                    rid,
                    id,
                    itemType,
                    `${itemType}s`,
                  ]
                );
            }

            if (!row?.id) {
              return null;
            }

            await emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );

            return row;
          }
        );

      if (!updated?.id) {
        await cleanupUploadedFile(
          req.file
        );

        return res
          .status(404)
          .json({
            error:
              "Item not found",
          });
      }

      return res.json({
        success: true,
        photo_url:
          imageUrl,
      });
    } catch (e) {
      await cleanupUploadedFile(
        req.file
      );

      console.error(
        "❌ item image upload failed:",
        e
      );

      if (
        sendMenuCatalogAuthorityError(
          res,
          e
        )
      ) {
        return;
      }

      return res
        .status(500)
        .json({
          error:
            "Failed to upload item image",
        });
    }
  }
);

module.exports = router;
