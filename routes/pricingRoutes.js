"use strict";

const express = require("express");
const router = express.Router();

const {
  authenticateToken,
} = require(
  "../middleware/authMiddleware"
);

const {
  loadMembership,
} = require(
  "../middleware/tenantMembership"
);

const {
  PERMISSIONS,
  hasPermission,
} = require(
  "../middleware/accessControl"
);

const {
  buildCanonicalCart,
  PricingError,
  sendPricingError,
} = require(
  "../services/orderPricingService"
);

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
  emitPricingRulesSnapshotTx,
} = require(
  "../edge/contracts/pricingRules"
);

const {
  buildAuthoritativeQuote,
  normalizeSurface,
} = require(
  "../services/pricingRulesService"
);

router.use(
  authenticateToken,
  loadMembership
);

function ridOf(req) {
  return Number(
    req.tenantRid ||
    req.user?.restaurant_id ||
    0
  );
}

function permissionSubject(req) {
  return {
    authority:
      req.membership?.authority ||
      req.user?.authority,

    permissions:
      req.membership?.permissions ||
      req.user?.permissions ||
      [],
  };
}

function canView(req) {
  const subject =
    permissionSubject(req);

  return (
    hasPermission(
      subject,
      PERMISSIONS.PRICING_VIEW
    ) ||
    hasPermission(
      subject,
      PERMISSIONS.PRICING_MANAGE
    )
  );
}

function canManage(req) {
  return hasPermission(
    permissionSubject(req),
    PERMISSIONS.PRICING_MANAGE
  );
}

function sendPricingAuthorityError(
  res,
  error
) {
  if (
    !(error instanceof
      MaksRuntimeRoleError)
  ) {
    return false;
  }

  if (
    error.code ===
      "MAKS_RUNTIME_ROLE_NOT_CLOUD"
  ) {
    res.status(409).json({
      error:
        "Pricing changes must be made through MAKS Cloud.",
      code:
        "PRICING_CLOUD_AUTHORITY_REQUIRED",
    });

    return true;
  }

  res.status(503).json({
    error:
      "Pricing changes are temporarily unavailable because the MAKS runtime role is not configured correctly.",
    code:
      "PRICING_RUNTIME_ROLE_UNAVAILABLE",
  });

  return true;
}

async function ensurePricingRulesTable(
  req
) {
  await req.qRun(`
    CREATE TABLE IF NOT EXISTS public.pricing_rules (
      id BIGSERIAL PRIMARY KEY,
      restaurant_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL DEFAULT 'fixed_bundle',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 0,
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      actions JSONB NOT NULL DEFAULT '{}'::jsonb,
      starts_at TIMESTAMPTZ NULL,
      ends_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await req.qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pricing_rules_rid_active
    ON public.pricing_rules (
      restaurant_id,
      active,
      priority
    )
  `);
}

function sanitizeRuleType(value) {
  const type = String(
    value || "fixed_bundle"
  )
    .trim()
    .toLowerCase();

  if (
    ![
      "fixed_bundle",
      "mix_match",
    ].includes(type)
  ) {
    return null;
  }

  return type;
}

function sanitizeConditions(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value;
}

function sanitizeActions(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value;
}

router.get(
  "/pricing-rules",
  async (req, res) => {
    try {
      await ensurePricingRulesTable(
        req
      );

      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant.",
        });
      }

      if (!canView(req)) {
        return res.status(403).json({
          error: "Not allowed.",
        });
      }

      const rows = await req.qAll(
        `
        SELECT *
        FROM public.pricing_rules
        WHERE restaurant_id = $1
        ORDER BY priority DESC, id DESC
        `,
        [rid]
      );

      return res.json(rows || []);
    } catch (error) {
      console.error(
        "❌ GET /pricing-rules failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to load pricing rules.",
      });
    }
  }
);

router.post(
  "/pricing-rules",
  async (req, res) => {
    try {
      await ensurePricingRulesTable(
        req
      );

      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant.",
        });
      }

      if (!canManage(req)) {
        return res.status(403).json({
          error: "Not allowed.",
        });
      }

      const body = req.body || {};

      const name = String(
        body.name || ""
      ).trim();

      if (!name) {
        return res.status(400).json({
          error:
            "Rule name required.",
        });
      }

      const ruleType =
        sanitizeRuleType(
          body.rule_type
        );

      if (!ruleType) {
        return res.status(400).json({
          error:
            "Unsupported pricing rule type.",
        });
      }

      const conditions =
        sanitizeConditions(
          body.conditions
        );

      const actions =
        sanitizeActions(
          body.actions
        );

      const bundlePrice = Number(
        actions.bundle_price || 0
      );

      if (
        !Number.isFinite(
          bundlePrice
        ) ||
        bundlePrice <= 0
      ) {
        return res.status(400).json({
          error:
            "A valid bundle price is required.",
        });
      }

      const components =
        Array.isArray(
          conditions.components
        )
          ? conditions.components
          : [];

      if (!components.length) {
        return res.status(400).json({
          error:
            "At least one rule component is required.",
        });
      }

      assertCloudRuntime();

      const saved =
        await withTx(
          async (tx) => {
            const row =
              await tx.qGet(
                `
                INSERT INTO public.pricing_rules (
                  restaurant_id,
                  name,
                  rule_type,
                  active,
                  priority,
                  conditions,
                  actions,
                  starts_at,
                  ends_at,
                  created_at,
                  updated_at
                )
                VALUES (
                  $1,
                  $2,
                  $3,
                  $4,
                  $5,
                  $6::jsonb,
                  $7::jsonb,
                  $8,
                  $9,
                  NOW(),
                  NOW()
                )
                RETURNING *
                `,
                [
                  rid,
                  name,
                  ruleType,
                  body.active !== false,
                  Number(
                    body.priority || 0
                  ),
                  JSON.stringify(
                    conditions
                  ),
                  JSON.stringify(
                    actions
                  ),
                  body.starts_at ||
                    null,
                  body.ends_at ||
                    null,
                ]
              );

            await emitPricingRulesSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );

            return row;
          }
        );

      return res
        .status(201)
        .json(saved);
    } catch (error) {
      if (
        sendPricingAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "❌ POST /pricing-rules failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create pricing rule.",
      });
    }
  }
);

router.post(
  "/pricing/quote",
  async (req, res) => {
    try {
      await ensurePricingRulesTable(
        req
      );

      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant.",
        });
      }

      const submittedItems =
        Array.isArray(
          req.body?.items
        )
          ? req.body.items
          : [];

      if (!submittedItems.length) {
        return res.json({
          items: [],
          subtotal: 0,
          discount: 0,
          pricing_discount: 0,
          total: 0,
          applied_rules: [],
        });
      }

      /*
       * Important:
       * buildCanonicalCart ignores frontend
       * prices and reloads every menu price
       * and option price from PostgreSQL.
       */
      const canonicalCart =
        await buildCanonicalCart(
          req,
          rid,
          submittedItems
        );

      const surface =
        normalizeSurface(
          req.body?.source ||
          req.body?.surface ||
          "pos"
        );

      const quote =
        await buildAuthoritativeQuote({
          db: req,
          restaurantId: rid,
          canonicalCart,
          surface,
        });

      return res.json(quote);
    } catch (error) {
      if (
        error instanceof
        PricingError
      ) {
        return sendPricingError(
          res,
          error
        );
      }

      console.error(
        "❌ POST /pricing/quote failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to quote cart.",
        code:
          "PRICING_QUOTE_FAILED",
      });
    }
  }
);

router.delete(
  "/pricing-rules/:id",
  async (req, res) => {
    try {
      await ensurePricingRulesTable(
        req
      );

      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant.",
        });
      }

      if (!canManage(req)) {
        return res.status(403).json({
          error: "Not allowed.",
        });
      }

      const id = Number(
        req.params.id
      );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid rule id.",
        });
      }

      assertCloudRuntime();

      const deleted =
        await withTx(
          async (tx) => {
            const row =
              await tx.qGet(
                `
                DELETE FROM public.pricing_rules
                WHERE id = $1
                  AND restaurant_id = $2
                RETURNING id
                `,
                [
                  id,
                  rid,
                ]
              );

            if (!row?.id) {
              return null;
            }

            await emitPricingRulesSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );

            return row;
          }
        );

      if (!deleted?.id) {
        return res.status(404).json({
          error:
            "Pricing rule not found.",
        });
      }

      return res.json({
        ok: true,
        id: deleted.id,
      });
    } catch (error) {
      if (
        sendPricingAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "❌ DELETE /pricing-rules/:id failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to delete pricing rule.",
      });
    }
  }
);

module.exports = router;