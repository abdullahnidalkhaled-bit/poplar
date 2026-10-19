const service = require("../services/lookup.service");

module.exports = {
  lookup: async (req, res) => res.success(await service.resolveCode(req.valid.query.code)),
  resolveQr: async (req, res) => res.success(await service.resolveQr(req.valid.body.payload)),
};
