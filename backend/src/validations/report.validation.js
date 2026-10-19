const { z, isoDate } = require("./common");

const dashboard = {};
const inventory = {};
const summary = { query: z.object({ from: isoDate, to: isoDate, tz: z.string().max(60).optional() }) };

module.exports = { dashboard, inventory, summary };
