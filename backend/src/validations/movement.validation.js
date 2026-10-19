const { z, isoDate, paging, dir } = require("./common");
const { LOCATIONS, MOVEMENT_TYPES } = require("../config/constants");

const list = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    type: z.enum(MOVEMENT_TYPES).optional(),
    location: z.enum(LOCATIONS).optional(),
    size: z.string().trim().max(10).optional(),
    series: z.string().trim().max(20).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    sort: z.enum(["createdAt", "type", "modelNumber", "qty"]).optional(),
    dir,
    ...paging,
  }),
};

module.exports = { list };
