const service = require("../services/productModel.service");

module.exports = {
  list: async (req, res) => res.success(await service.listModels(req.valid.query)),
  facets: async (req, res) => res.success(await service.facets()),
  suggestNumber: async (req, res) => res.success({ modelNumber: await service.suggestModelNumber(req.valid.query.brand) }),
  create: async (req, res) => res.success(await service.createModel(req.valid.body), 201),
  get: async (req, res) => res.success(await service.getDetail(req.valid.params.modelNumber)),
  update: async (req, res) => res.success(await service.updateModel(req.valid.params.modelNumber, req.valid.body)),
  archive: async (req, res) => res.success(await service.setActive(req.valid.params.modelNumber, false)),
  restore: async (req, res) => res.success(await service.setActive(req.valid.params.modelNumber, true)),
  qr: async (req, res) => res.success(await service.qr(req.valid.params.modelNumber)),
};
