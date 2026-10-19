const { z, str } = require("./common");

const lookup = { query: z.object({ code: str("الرمز", 200) }) };
const resolveQr = { body: z.object({ payload: str("حمولة QR", 200) }).strict() };

module.exports = { lookup, resolveQr };
