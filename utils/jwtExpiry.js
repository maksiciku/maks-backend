function getNextMonthlyLogoutAt() {
  const now = new Date();

  // next logout point = 1st day of next month at 02:00 local server time
  const year = now.getFullYear();
  const month = now.getMonth();

  let next = new Date(year, month + 1, 1, 2, 0, 0, 0);

  if (next <= now) {
    next = new Date(year, month + 2, 1, 2, 0, 0, 0);
  }

  return next;
}

function getJwtExpirySecondsFromNow() {
  const nowMs = Date.now();
  const nextMs = getNextMonthlyLogoutAt().getTime();
  return Math.max(60, Math.floor((nextMs - nowMs) / 1000));
}

module.exports = {
  getNextMonthlyLogoutAt,
  getJwtExpirySecondsFromNow,
};