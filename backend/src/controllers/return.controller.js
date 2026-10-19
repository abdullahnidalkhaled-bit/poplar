const service = require("../services/return.service");

module.exports = {
  create: async (req, res) => res.success(await service.createReturn(req.valid.body, { id: req.user.id, name: req.user.name }), 201),
  list: async (req, res) => res.success(await service.list(req.valid.query)),
};
