const service = require("../services/setting.service");

module.exports = {
  get: async (req, res) => res.success(await service.get()),
  update: async (req, res) => res.success(await service.update(req.valid.body)),
};
