const express = require("express");
const Stripe = require("stripe");
const jwt = require("jsonwebtoken");
const { SECRET_KEY } =
  require("../utils/constants");
const { qRun } = require("../dbCompat");

const router = express.Router();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const PRICE_MAP = {
  starter: {
    priceId: process.env.STRIPE_PRICE_STARTER,
    planKey: "starter",
    monthlyPrice: 79,
    displayName: "MAKS OS Starter",
    deviceLimit: 2,
    coupon: process.env.STRIPE_LAUNCH_COUPON || null,
  },
  professional: {
    priceId: process.env.STRIPE_PRICE_PRO,
    planKey: "professional",
    monthlyPrice: 139,
    displayName: "MAKS OS Professional",
    deviceLimit: 5,
    coupon: null,
  },
  enterprise: {
    priceId: process.env.STRIPE_PRICE_ENTERPRISE,
    planKey: "enterprise",
    monthlyPrice: 249,
    displayName: "MAKS OS Enterprise",
    deviceLimit: 12,
    coupon: null,
  },
};

function getFrontendUrl() {
  return String(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
}

function stripeTsToIso(ts) {
  return ts ? new Date(Number(ts) * 1000).toISOString() : null;
}

function getPlanFromMetadata(metadata = {}) {
  const planKey = String(metadata.plan_key || "starter").trim().toLowerCase();
  return PRICE_MAP[planKey] || PRICE_MAP.starter;
}

async function updateRestaurantFromCheckoutSession(session) {
  const metadata = session.metadata || {};
  const plan = getPlanFromMetadata(metadata);

  const email = String(metadata.email || "").trim().toLowerCase();
  const restaurantName = String(metadata.restaurant_name || "").trim();

  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id || null;

  const subscription =
    typeof session.subscription === "string"
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription || null;

  const subscriptionId =
    typeof subscription === "string" ? subscription : subscription?.id || null;

  const subStatus = subscription?.status || "active";
  const periodEnd = stripeTsToIso(subscription?.current_period_end);

  await qRun(
    `
    UPDATE public.restaurants
    SET
      plan_key = ?,
      monthly_price = ?,
      device_limit = ?,
      billing_status = 'active',
      account_status = 'active',
      stripe_customer_id = ?,
      stripe_subscription_id = ?,
      stripe_checkout_session_id = ?,
      stripe_subscription_status = ?,
      stripe_current_period_end = ?
    WHERE LOWER(TRIM(owner_email)) = LOWER(TRIM(?))
       OR LOWER(TRIM(name)) = LOWER(TRIM(?))
    `,
    [
      plan.planKey,
      plan.monthlyPrice,
      plan.deviceLimit,
      customerId,
      subscriptionId,
      session.id,
      subStatus,
      periodEnd,
      email,
      restaurantName,
    ]
  );

  console.log("✅ MAKS billing activated:", restaurantName, email, plan.planKey);
}

router.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const { plan_key, registration } = req.body || {};
    const cleanPlan = String(plan_key || "").trim().toLowerCase();
    const plan = PRICE_MAP[cleanPlan];

    if (!plan || !plan.priceId) {
      return res.status(400).json({ error: "Invalid or missing plan_key" });
    }

    const email = String(registration?.email || "").trim().toLowerCase();
    const restaurantName = String(registration?.restaurant_name || "").trim();

    if (!email || !restaurantName) {
      return res.status(400).json({
        error: "Registration email and restaurant name are required",
      });
    }

    const frontendUrl = getFrontendUrl();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      discounts: plan.coupon ? [{ coupon: plan.coupon }] : [],
      success_url: `${frontendUrl}/register-success?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(plan.planKey)}`,
      cancel_url: `${frontendUrl}/register-plan?cancelled=1`,
      metadata: {
        plan_key: plan.planKey,
        monthly_price: String(plan.monthlyPrice),
        device_limit: String(plan.deviceLimit),
        restaurant_name: restaurantName,
        email,
      },
      subscription_data: {
        metadata: {
          plan_key: plan.planKey,
          monthly_price: String(plan.monthlyPrice),
          device_limit: String(plan.deviceLimit),
          restaurant_name: restaurantName,
          email,
        },
      },
    });

    return res.json({
      success: true,
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error("❌ Stripe checkout session failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to create checkout session",
    });
  }
});

router.post(
  "/confirm-checkout-session",
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(500).json({
          error:
            "Stripe is not configured",
        });
      }

      const sessionId =
        String(
          req.body?.session_id ||
          ""
        ).trim();

      if (
        !sessionId ||
        !sessionId.startsWith(
          "cs_"
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid session_id",
        });
      }

      /*
       * =====================================================
       * LOAD CHECKOUT DIRECTLY FROM STRIPE
       * =====================================================
       */

      const session =
        await stripe
          .checkout
          .sessions
          .retrieve(
            sessionId,
            {
              expand: [
                "subscription",
                "customer",
              ],
            }
          );

      if (
        session.status !==
        "complete"
      ) {
        return res.status(400).json({
          error:
            "Stripe checkout is not complete",
        });
      }

      /*
       * =====================================================
       * PLAN AUTHORITY
       *
       * Never trust plan/price/device values supplied by
       * the browser.
       *
       * These values were written into Stripe metadata by
       * our own create-checkout-session endpoint.
       * =====================================================
       */

      const metadata =
        session.metadata || {};

      const planKey =
        String(
          metadata.plan_key ||
          ""
        )
          .trim()
          .toLowerCase();

      const plan =
        PRICE_MAP[planKey];

      if (!plan) {
        return res.status(400).json({
          error:
            "Checkout contains invalid plan metadata",
        });
      }

      /*
       * Verify that the actual Stripe line item uses the
       * expected Stripe Price ID for this MAKS plan.
       */

      const lineItems =
        await stripe
          .checkout
          .sessions
          .listLineItems(
            sessionId,
            {
              limit: 10,
            }
          );

      const actualPriceId =
        lineItems?.data?.[0]
          ?.price?.id ||
        null;

      if (
        !actualPriceId ||
        actualPriceId !==
          plan.priceId
      ) {
        return res.status(400).json({
          error:
            "Checkout price does not match MAKS plan",
        });
      }

      /*
       * =====================================================
       * AUTHORITATIVE SUBSCRIPTION
       * =====================================================
       */

      let subscription =
        session.subscription ||
        null;

      if (
        typeof subscription ===
        "string"
      ) {
        subscription =
          await stripe
            .subscriptions
            .retrieve(
              subscription
            );
      }

      if (!subscription?.id) {
        return res.status(400).json({
          error:
            "Stripe subscription is missing",
        });
      }

      const subscriptionStatus =
        String(
          subscription.status ||
          ""
        )
          .trim()
          .toLowerCase();

      if (
        ![
          "active",
          "trialing",
        ].includes(
          subscriptionStatus
        )
      ) {
        return res.status(400).json({
          error:
            "Stripe subscription is not active",
        });
      }

      const email =
        String(
          metadata.email ||
          session.customer_details
            ?.email ||
          session.customer_email ||
          ""
        )
          .trim()
          .toLowerCase();

      const restaurantName =
        String(
          metadata
            .restaurant_name ||
          ""
        ).trim();

      if (
        !email ||
        !restaurantName
      ) {
        return res.status(400).json({
          error:
            "Checkout registration identity is missing",
        });
      }

      const customerId =
        typeof session.customer ===
        "string"
          ? session.customer
          : session.customer
              ?.id ||
            null;

      const periodEnd =
        stripeTsToIso(
          subscription
            ?.current_period_end
        );

      /*
       * =====================================================
       * SIGNED MAKS REGISTRATION ENTITLEMENT
       * =====================================================
       *
       * The browser may transport this token.
       * It cannot alter its contents.
       */

      const registrationToken =
        jwt.sign(
          {
            type:
              "restaurant_registration",

            email,

            restaurant_name:
              restaurantName,

            plan_key:
              plan.planKey,

            monthly_price:
              plan.monthlyPrice,

            device_limit:
              plan.deviceLimit,

            stripe_checkout_session_id:
              session.id,

            stripe_customer_id:
              customerId,

            stripe_subscription_id:
              subscription.id,

            stripe_subscription_status:
              subscriptionStatus,

            stripe_current_period_end:
              periodEnd,
          },

          SECRET_KEY,

          {
            expiresIn:
              "15m",

            issuer:
              "maks-stripe",

            audience:
              "maks-registration",
          }
        );

      return res.json({
        success: true,

        registration_token:
          registrationToken,

        /*
         * These are informational only.
         * /register-restaurant will NOT trust them.
         */

        plan_key:
          plan.planKey,

        monthly_price:
          plan.monthlyPrice,

        device_limit:
          plan.deviceLimit,

        stripe_checkout_session_id:
          session.id,

        stripe_customer_id:
          customerId,

        stripe_subscription_id:
          subscription.id,

        stripe_subscription_status:
          subscriptionStatus,

        stripe_current_period_end:
          periodEnd,
      });
    } catch (err) {
      console.error(
        "❌ confirm-checkout-session failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to confirm Stripe checkout",
        });
    }
  }
);

router.post("/webhook", async (req, res) => {
  try {
    if (!stripe) return res.status(500).send("Stripe not configured");

    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(500).send("Stripe webhook secret missing");
    }

    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      await updateRestaurantFromCheckoutSession(session);
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;

      await qRun(
        `
        UPDATE public.restaurants
        SET
          billing_status = ?,
          stripe_subscription_status = ?,
          stripe_current_period_end = ?
        WHERE stripe_subscription_id = ?
        `,
        [
          subscription.status === "active" ? "active" : subscription.status,
          subscription.status || null,
          stripeTsToIso(subscription.current_period_end),
          subscription.id,
        ]
      );

      console.log("🔄 Subscription updated:", subscription.id, subscription.status);
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;

      await qRun(
        `
        UPDATE public.restaurants
        SET
          billing_status = 'cancelled',
          stripe_subscription_status = 'cancelled'
        WHERE stripe_subscription_id = ?
        `,
        [subscription.id]
      );

      console.log("❌ Subscription cancelled:", subscription.id);
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;

      await qRun(
        `
        UPDATE public.restaurants
        SET billing_status = 'payment_failed'
        WHERE stripe_customer_id = ?
        `,
        [invoice.customer]
      );

      console.log("⚠️ Payment failed:", invoice.customer);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Stripe webhook failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

module.exports = router;