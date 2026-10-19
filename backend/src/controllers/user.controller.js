const service = require("../services/user.service");

module.exports = {
  list: async (req, res) => res.success(await service.list()),
  create: async (req, res) => res.success(await service.create(req.valid.body), 201),
  update: async (req, res) => res.success(await service.update(req.valid.params.id, req.valid.body)),
  resetPassword: async (req, res) => res.success(await service.resetPassword(req.valid.params.id, req.valid.body.password)),
};
