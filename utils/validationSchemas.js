// backend/utils/validationSchemas.js
const Joi = require("joi");

// ✅ Profile update validation
const profileUpdateSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).optional().allow(""),
  address: Joi.string().max(255).optional().allow(""),
  membership_tier: Joi.string().valid("basic", "premium", "vip", "").optional().allow(null, ""),
});

// ✅ Password change validation
const passwordChangeSchema = Joi.object({
  current_password: Joi.string().min(4).max(100).required(),
  new_password: Joi.string().min(4).max(100).required(),
});

module.exports = {
  profileUpdateSchema,
  passwordChangeSchema,
};
