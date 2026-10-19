const service = require("../services/stock.service");

module.exports = {
  receive: async (req, res) => {
    const out = await service.receiveShipment(req.valid.body, req.user);
    res.success(out, out.duplicate ? 200 : 201);
  },
  transfer: async (req, res) => res.success(await service.transfer(req.valid.body)),
  damage: async (req, res) => res.success(await service.damage(req.valid.body)),
  adjust: async (req, res) => res.success(await service.adjust(req.valid.body)),
};
