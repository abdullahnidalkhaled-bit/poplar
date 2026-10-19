const { MAX_PAGE_SIZE } = require("../config/constants");

const parsePaging = ({ page, limit } = {}, defaultLimit = 20) => {
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit) || defaultLimit));
  return { page: p, limit: l, skip: (p - 1) * l };
};

const pageResult = (items, total, { page, limit }) => ({
  items,
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});

module.exports = { parsePaging, pageResult };
