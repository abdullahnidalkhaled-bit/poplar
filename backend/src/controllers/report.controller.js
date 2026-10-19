const service = require("../services/report.service");

module.exports = {
  dashboard: async (req, res) => res.success(await service.dashboard()),
  inventory: async (req, res) => res.success(await service.inventoryReport()),
  summary: async (req, res) => res.success(await service.summary(req.valid.query)),
};
