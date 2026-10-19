const service = require("../services/movement.service");

module.exports = {
  list: async (req, res) => res.success(await service.list(req.valid.query)),
};
