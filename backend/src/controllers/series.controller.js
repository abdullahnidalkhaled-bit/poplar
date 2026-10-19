const service = require("../services/series.service");

module.exports = {
  list: async (req, res) => res.success(await service.list(req.valid.query)),
  detail: async (req, res) => res.success(await service.detail(req.valid.params.seriesNo)),
};
