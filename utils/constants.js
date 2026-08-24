// backend/utils/constants.js
require('dotenv').config();

const SECRET_KEY = process.env.JWT_SECRET || process.env.SECRET_KEY || 'dev-secret-change-me';
const TOKEN_TTL  = process.env.JWT_TTL || '8h'; // legacy fallback only
const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);

module.exports = {
  SECRET_KEY,
  TOKEN_TTL,
  SALT_ROUNDS,
};