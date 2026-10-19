const service = require("../services/invoice.service");

module.exports = {
  create: async (req, res) => res.success(await service.createInvoice(req.valid.body, { id: req.user.id, name: req.user.name }), 201),
  list: async (req, res) => res.success(await service.list(req.valid.query)),
  get: async (req, res) => res.success(await service.getInvoice(req.valid.params.id)),
  cancel: async (req, res) => res.success(await service.cancelInvoice(req.valid.params.id, { id: req.user.id, name: req.user.name })),
};
