// validators/profileSchemas.js
const Joi = require('joi');

exports.updateMeSchema = Joi.object({
  full_name: Joi.string().trim().min(1).max(120).allow('', null),
  address: Joi.string().trim().min(1).max(240).allow('', null),
  membership_tier: Joi.string().valid('Basic','Silver','Gold','Platinum').allow(null)
}).min(1);

exports.changePasswordSchema = Joi.object({
  current_password: Joi.string().min(1).required(),
  new_password: Joi.string()
    .min(8)
    .max(128)
    .pattern(/[A-Z]/, 'uppercase')
    .pattern(/[a-z]/, 'lowercase')
    .pattern(/[0-9]/, 'number')
    .pattern(/[^A-Za-z0-9]/, 'symbol')
    .required()
});
