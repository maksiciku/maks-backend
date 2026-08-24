"use strict";

/*
=========================================================
MAKS CC REPAIR SERVICE

Transactional platform repairs only.

Rules:
- PostgreSQL only
- no Express req/res
- explicit confirmation required by routes
- validate again inside the transaction
- lock affected records
- preserve existing data unless the repair requires it
- write complete before/after audit
=========================================================
*/

function createRepairError(
  message,
  statusCode,
  code
) {
  const error = new Error(message);

  error.statusCode = Number(
    statusCode || 500
  );

  error.code =
    code || "CC_REPAIR_FAILED";

  return error;
}

/**
 * Repairs a mismatch where:
 *
 * users.restaurant_id
 *      differs from
 * restaurant_members.restaurant_id
 *
 * Supported actions:
 *
 * align_user_to_membership
 *   Updates users.restaurant_id to match the
 *   membership restaurant.
 *
 * align_membership_to_user
 *   Updates restaurant_members.restaurant_id to
 *   match the user's primary restaurant.
 */
async function repairMembershipMismatch(
  tx,
  {
    membershipId,
    userId,
    action,
    adminUserId,
    reason,
  }
) {
  if (
    !tx?.qGet ||
    !tx?.qRun
  ) {
    throw new Error(
      "repairMembershipMismatch requires an active transaction"
    );
  }

  const cleanAction = String(
    action || ""
  )
    .trim()
    .toLowerCase();

  const cleanReason = String(
    reason || ""
  ).trim();

  const allowedActions = new Set([
    "align_user_to_membership",
    "align_membership_to_user",
  ]);

  if (
    !Number.isInteger(
      Number(membershipId)
    ) ||
    Number(membershipId) <= 0
  ) {
    throw createRepairError(
      "Invalid membership id.",
      400,
      "CC_INVALID_MEMBERSHIP_ID"
    );
  }

  if (
    !Number.isInteger(Number(userId)) ||
    Number(userId) <= 0
  ) {
    throw createRepairError(
      "Invalid user id.",
      400,
      "CC_INVALID_USER_ID"
    );
  }

  if (!allowedActions.has(cleanAction)) {
    throw createRepairError(
      "Invalid membership repair action.",
      400,
      "CC_INVALID_MEMBERSHIP_REPAIR_ACTION"
    );
  }

  if (cleanReason.length < 10) {
    throw createRepairError(
      "Enter a clear repair reason of at least 10 characters.",
      400,
      "CC_REPAIR_REASON_REQUIRED"
    );
  }

  /*
   * Lock both the membership and user records.
   *
   * The relationships are rechecked inside the
   * transaction so stale frontend data cannot
   * perform an incorrect repair.
   */
  const current = await tx.qGet(
    `
    SELECT
      rm.id AS membership_id,
      rm.restaurant_id
        AS membership_restaurant_id,
      rm.user_id,
      rm.role AS membership_role,
      rm.status AS membership_status,
      rm.is_active AS membership_is_active,
      rm.permissions
        AS membership_permissions,
      rm.created_at
        AS membership_created_at,

      membership_restaurant.id
        AS valid_membership_restaurant_id,
      membership_restaurant.name
        AS membership_restaurant_name,

      u.restaurant_id
        AS user_restaurant_id,
      u.username,
      u.full_name,
      u.role AS user_role,
      u.is_active AS user_is_active,
      u.can_pos_login,
      u.force_password_reset,
      u.created_at AS user_created_at,

      user_restaurant.id
        AS valid_user_restaurant_id,
      user_restaurant.name
        AS user_restaurant_name

    FROM public.restaurant_members rm

    JOIN public.users u
      ON u.id = rm.user_id

    LEFT JOIN public.restaurants
      membership_restaurant
      ON membership_restaurant.id =
         rm.restaurant_id

    LEFT JOIN public.restaurants
      user_restaurant
      ON user_restaurant.id =
         u.restaurant_id

    WHERE rm.id = $1
      AND rm.user_id = $2

    FOR UPDATE OF rm, u
    `,
    [
      Number(membershipId),
      Number(userId),
    ]
  );

  if (!current?.membership_id) {
    throw createRepairError(
      "The membership or user relationship was not found.",
      404,
      "CC_MEMBERSHIP_RELATIONSHIP_NOT_FOUND"
    );
  }

  if (
    current.user_restaurant_id == null
  ) {
    throw createRepairError(
      "The user has no primary restaurant. This mismatch requires a different repair.",
      409,
      "CC_USER_HAS_NO_PRIMARY_RESTAURANT"
    );
  }

  if (
    Number(current.user_restaurant_id) ===
    Number(
      current.membership_restaurant_id
    )
  ) {
    throw createRepairError(
      "The membership mismatch has already been resolved.",
      409,
      "CC_MEMBERSHIP_ALREADY_ALIGNED"
    );
  }

  const before = {
    membership: {
      id: Number(
        current.membership_id
      ),

      user_id: Number(
        current.user_id
      ),

      restaurant_id:
        current.membership_restaurant_id !=
        null
          ? Number(
              current.membership_restaurant_id
            )
          : null,

      restaurant_name:
        current.membership_restaurant_name ||
        null,

      role:
        current.membership_role || null,

      status:
        current.membership_status || null,

      is_active:
        !!current.membership_is_active,

      permissions:
        current.membership_permissions ||
        {},
    },

    user: {
      id: Number(current.user_id),

      restaurant_id:
        current.user_restaurant_id != null
          ? Number(
              current.user_restaurant_id
            )
          : null,

      restaurant_name:
        current.user_restaurant_name ||
        null,

      username:
        current.username || null,

      full_name:
        current.full_name || null,

      role:
        current.user_role || null,

      is_active:
        !!current.user_is_active,

      can_pos_login:
        !!current.can_pos_login,

      force_password_reset:
        !!current.force_password_reset,
    },
  };

  let targetRestaurantId;
  let targetRestaurantName;
  let updatedUser = null;
  let updatedMembership = null;

  if (
    cleanAction ===
    "align_user_to_membership"
  ) {
    if (
      !current
        .valid_membership_restaurant_id
    ) {
      throw createRepairError(
        "The membership restaurant does not exist. The user cannot be aligned to it.",
        409,
        "CC_MEMBERSHIP_RESTAURANT_MISSING"
      );
    }

    targetRestaurantId = Number(
      current.membership_restaurant_id
    );

    targetRestaurantName =
      current.membership_restaurant_name ||
      "";

    updatedUser = await tx.qGet(
      `
      UPDATE public.users
      SET restaurant_id = $1
      WHERE id = $2
        AND restaurant_id = $3
      RETURNING
        id,
        restaurant_id,
        username,
        full_name,
        role,
        is_active,
        can_pos_login,
        force_password_reset
      `,
      [
        targetRestaurantId,
        Number(current.user_id),
        Number(
          current.user_restaurant_id
        ),
      ]
    );

    if (!updatedUser?.id) {
      throw createRepairError(
        "The user changed during repair. No update was applied.",
        409,
        "CC_USER_CHANGED_DURING_REPAIR"
      );
    }
  }

  if (
    cleanAction ===
    "align_membership_to_user"
  ) {
    if (
      !current.valid_user_restaurant_id
    ) {
      throw createRepairError(
        "The user's primary restaurant does not exist. The membership cannot be aligned to it.",
        409,
        "CC_USER_RESTAURANT_MISSING"
      );
    }

    targetRestaurantId = Number(
      current.user_restaurant_id
    );

    targetRestaurantName =
      current.user_restaurant_name || "";

    /*
     * Prevent duplicate membership records.
     *
     * We do not merge or delete memberships
     * automatically because roles, permissions and
     * activation states may differ.
     */
    const duplicateMembership =
      await tx.qGet(
        `
        SELECT
          id,
          restaurant_id,
          user_id,
          role,
          status,
          is_active
        FROM public.restaurant_members
        WHERE user_id = $1
          AND restaurant_id = $2
          AND id <> $3
        LIMIT 1
        FOR UPDATE
        `,
        [
          Number(current.user_id),
          targetRestaurantId,
          Number(
            current.membership_id
          ),
        ]
      );

    if (duplicateMembership?.id) {
      throw createRepairError(
        `User already has membership #${Number(
          duplicateMembership.id
        )} for the destination restaurant. Manual duplicate review is required.`,
        409,
        "CC_DUPLICATE_MEMBERSHIP_EXISTS"
      );
    }

    updatedMembership = await tx.qGet(
      `
      UPDATE public.restaurant_members
      SET restaurant_id = $1
      WHERE id = $2
        AND user_id = $3
        AND restaurant_id = $4
      RETURNING
        id,
        restaurant_id,
        user_id,
        role,
        status,
        is_active,
        permissions,
        created_at
      `,
      [
        targetRestaurantId,
        Number(
          current.membership_id
        ),
        Number(current.user_id),
        Number(
          current
            .membership_restaurant_id
        ),
      ]
    );

    if (!updatedMembership?.id) {
      throw createRepairError(
        "The membership changed during repair. No update was applied.",
        409,
        "CC_MEMBERSHIP_CHANGED_DURING_REPAIR"
      );
    }
  }

  const after = {
    membership: {
      id: Number(
        current.membership_id
      ),

      user_id: Number(
        current.user_id
      ),

      restaurant_id:
        updatedMembership
          ?.restaurant_id != null
          ? Number(
              updatedMembership.restaurant_id
            )
          : Number(
              current
                .membership_restaurant_id
            ),

      restaurant_name:
        cleanAction ===
        "align_membership_to_user"
          ? targetRestaurantName
          : current
              .membership_restaurant_name ||
            null,

      role:
        updatedMembership?.role ||
        current.membership_role ||
        null,

      status:
        updatedMembership?.status ||
        current.membership_status ||
        null,

      is_active:
        updatedMembership
          ? !!updatedMembership.is_active
          : !!current
              .membership_is_active,

      permissions:
        updatedMembership?.permissions ||
        current
          .membership_permissions ||
        {},
    },

    user: {
      id: Number(current.user_id),

      restaurant_id:
        updatedUser?.restaurant_id !=
        null
          ? Number(
              updatedUser.restaurant_id
            )
          : Number(
              current.user_restaurant_id
            ),

      restaurant_name:
        cleanAction ===
        "align_user_to_membership"
          ? targetRestaurantName
          : current.user_restaurant_name ||
            null,

      username:
        updatedUser?.username ||
        current.username ||
        null,

      full_name:
        updatedUser?.full_name ||
        current.full_name ||
        null,

      role:
        updatedUser?.role ||
        current.user_role ||
        null,

      is_active:
        updatedUser
          ? !!updatedUser.is_active
          : !!current.user_is_active,

      can_pos_login:
        updatedUser
          ? !!updatedUser.can_pos_login
          : !!current.can_pos_login,

      force_password_reset:
        updatedUser
          ? !!updatedUser
              .force_password_reset
          : !!current
              .force_password_reset,
    },
  };

  await tx.qRun(
    `
    INSERT INTO public.platform_admin_audit (
      admin_user_id,
      action,
      target_restaurant_id,
      entity,
      entity_id,
      meta,
      created_at
    )
    VALUES (
      $1,
      'CC_REPAIR_MEMBERSHIP_MISMATCH',
      $2,
      'restaurant_members',
      $3,
      $4::jsonb,
      NOW()
    )
    `,
    [
      Number(adminUserId),
      targetRestaurantId,
      String(current.membership_id),

      JSON.stringify({
        repair_action:
          cleanAction,

        reason:
          cleanReason,

        target_restaurant_id:
          targetRestaurantId,

        target_restaurant_name:
          targetRestaurantName || null,

        before,
        after,
      }),
    ]
  );

  return {
    membership_id:
      Number(current.membership_id),

    user_id:
      Number(current.user_id),

    action:
      cleanAction,

    target_restaurant_id:
      targetRestaurantId,

    target_restaurant_name:
      targetRestaurantName || "",

    before,
    after,
  };
}

/**
 * Transfers restaurant ownership to an existing,
 * active restaurant member.
 *
 * Rules:
 * - exactly one active owner after completion;
 * - selected user must already belong to restaurant;
 * - selected membership and user must both be active;
 * - previous owners are demoted to admin or manager;
 * - transaction and full audit are mandatory.
 */
async function transferRestaurantOwnership(
  tx,
  {
    restaurantId,
    newOwnerUserId,
    previousOwnerRole,
    adminUserId,
    reason,
  }
) {
  if (!tx?.qGet || !tx?.qAll || !tx?.qRun) {
    throw new Error(
      "transferRestaurantOwnership requires an active transaction"
    );
  }

  const rid = Number(restaurantId);
  const newOwnerId = Number(newOwnerUserId);

  const demotionRole = String(
    previousOwnerRole || ""
  )
    .trim()
    .toLowerCase();

  const cleanReason = String(
    reason || ""
  ).trim();

  if (!Number.isInteger(rid) || rid <= 0) {
    throw createRepairError(
      "Invalid restaurant id.",
      400,
      "CC_INVALID_RESTAURANT_ID"
    );
  }

  if (
    !Number.isInteger(newOwnerId) ||
    newOwnerId <= 0
  ) {
    throw createRepairError(
      "Select a valid new owner.",
      400,
      "CC_INVALID_NEW_OWNER"
    );
  }

  if (
    !["admin", "manager"].includes(
      demotionRole
    )
  ) {
    throw createRepairError(
      "Choose whether previous owners become admin or manager.",
      400,
      "CC_INVALID_PREVIOUS_OWNER_ROLE"
    );
  }

  if (cleanReason.length < 10) {
    throw createRepairError(
      "Enter a clear ownership-transfer reason of at least 10 characters.",
      400,
      "CC_TRANSFER_REASON_REQUIRED"
    );
  }

  /*
   * Lock the restaurant first.
   */
  const restaurant = await tx.qGet(
    `
    SELECT
      id,
      name,
      account_status
    FROM public.restaurants
    WHERE id = $1
    FOR UPDATE
    `,
    [rid]
  );

  if (!restaurant?.id) {
    throw createRepairError(
      "Restaurant was not found.",
      404,
      "CC_RESTAURANT_NOT_FOUND"
    );
  }

  /*
   * Lock every membership belonging to this restaurant.
   */
  const memberships = await tx.qAll(
    `
    SELECT
      rm.id AS membership_id,
      rm.restaurant_id,
      rm.user_id,
      rm.role,
      rm.status,
      rm.is_active,
      rm.permissions,

      u.username,
      u.full_name,
      u.role AS user_role,
      u.is_active AS user_is_active,
      u.restaurant_id AS user_restaurant_id

    FROM public.restaurant_members rm

    JOIN public.users u
      ON u.id = rm.user_id

    WHERE rm.restaurant_id = $1

    ORDER BY rm.id ASC

    FOR UPDATE OF rm, u
    `,
    [rid]
  );

  const selected = memberships.find(
    (member) =>
      Number(member.user_id) ===
      newOwnerId
  );

  if (!selected) {
    throw createRepairError(
      "The selected user is not a member of this restaurant.",
      409,
      "CC_NEW_OWNER_NOT_RESTAURANT_MEMBER"
    );
  }

  if (
    selected.is_active !== true ||
    selected.user_is_active !== true
  ) {
    throw createRepairError(
      "The selected membership and user account must both be active.",
      409,
      "CC_NEW_OWNER_NOT_ACTIVE"
    );
  }

  if (
    Number(selected.user_restaurant_id) !==
    rid
  ) {
    throw createRepairError(
      "The selected user primary restaurant does not match this restaurant.",
      409,
      "CC_NEW_OWNER_TENANT_MISMATCH"
    );
  }

  const activeOwnersBefore =
    memberships.filter(
      (member) =>
        member.is_active === true &&
        member.user_is_active === true &&
        String(member.role || "")
          .trim()
          .toLowerCase() === "owner"
    );

  const before = {
    restaurant: {
      id: rid,
      name: restaurant.name || "",
      account_status:
        restaurant.account_status || "",
    },

    active_owners:
      activeOwnersBefore.map(
        (owner) => ({
          membership_id: Number(
            owner.membership_id
          ),
          user_id: Number(
            owner.user_id
          ),
          username:
            owner.username || null,
          full_name:
            owner.full_name || null,
          role:
            owner.role || null,
        })
      ),

    selected_member: {
      membership_id: Number(
        selected.membership_id
      ),
      user_id: Number(
        selected.user_id
      ),
      username:
        selected.username || null,
      full_name:
        selected.full_name || null,
      previous_role:
        selected.role || null,
    },
  };

  /*
   * Demote every current owner except the selected user.
   */
  await tx.qRun(
    `
    UPDATE public.restaurant_members
    SET role = $1
    WHERE restaurant_id = $2
      AND LOWER(COALESCE(role, '')) = 'owner'
      AND user_id <> $3
    `,
    [
      demotionRole,
      rid,
      newOwnerId,
    ]
  );

  /*
   * Promote selected membership and ensure it remains active.
   */
  const promoted = await tx.qGet(
    `
    UPDATE public.restaurant_members
    SET
      role = 'owner',
      status = 'active',
      is_active = TRUE
    WHERE restaurant_id = $1
      AND user_id = $2
    RETURNING
      id,
      restaurant_id,
      user_id,
      role,
      status,
      is_active,
      permissions
    `,
    [rid, newOwnerId]
  );

  if (!promoted?.id) {
    throw createRepairError(
      "The selected membership could not be promoted.",
      409,
      "CC_OWNER_PROMOTION_FAILED"
    );
  }

  /*
   * Revalidate the final state.
   */
  const ownerCheck = await tx.qAll(
    `
    SELECT
      rm.id AS membership_id,
      rm.user_id,
      rm.role,
      rm.is_active,
      u.username,
      u.full_name,
      u.is_active AS user_is_active

    FROM public.restaurant_members rm

    JOIN public.users u
      ON u.id = rm.user_id

    WHERE rm.restaurant_id = $1
      AND rm.is_active = TRUE
      AND u.is_active = TRUE
      AND LOWER(COALESCE(rm.role, '')) =
          'owner'

    FOR UPDATE OF rm, u
    `,
    [rid]
  );

  if (ownerCheck.length !== 1) {
    throw createRepairError(
      `Ownership verification failed. Expected exactly one active owner but found ${ownerCheck.length}.`,
      409,
      "CC_OWNER_COUNT_VERIFICATION_FAILED"
    );
  }

  if (
    Number(ownerCheck[0].user_id) !==
    newOwnerId
  ) {
    throw createRepairError(
      "Ownership verification returned the wrong owner.",
      409,
      "CC_OWNER_VERIFICATION_MISMATCH"
    );
  }

  const after = {
    active_owner: {
      membership_id: Number(
        ownerCheck[0].membership_id
      ),
      user_id: Number(
        ownerCheck[0].user_id
      ),
      username:
        ownerCheck[0].username || null,
      full_name:
        ownerCheck[0].full_name || null,
      role: "owner",
    },

    previous_owner_role:
      demotionRole,

    active_owner_count:
      ownerCheck.length,
  };

  await tx.qRun(
    `
    INSERT INTO public.platform_admin_audit (
      admin_user_id,
      action,
      target_restaurant_id,
      entity,
      entity_id,
      meta,
      created_at
    )
    VALUES (
      $1,
      'CC_TRANSFER_RESTAURANT_OWNERSHIP',
      $2,
      'restaurants',
      $3,
      $4::jsonb,
      NOW()
    )
    `,
    [
      Number(adminUserId),
      rid,
      String(rid),

      JSON.stringify({
        reason: cleanReason,
        before,
        after,
      }),
    ]
  );

  return {
    restaurant_id: rid,
    restaurant_name:
      restaurant.name || "",

    new_owner: after.active_owner,

    previous_owner_role:
      demotionRole,

    before,
    after,
  };
}

module.exports = {
  repairMembershipMismatch,
  transferRestaurantOwnership,
};