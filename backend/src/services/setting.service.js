const settingRepo = require("../repositories/setting.repository");

const get = () => settingRepo.upsertMain();

async function update({ usdToSyp, lowStockThreshold }) {
  const patch = {};
  if (usdToSyp !== undefined) patch.usdToSyp = usdToSyp;
  if (lowStockThreshold !== undefined) patch.lowStockThreshold = lowStockThreshold;
  return settingRepo.upsertMain(patch);
}

module.exports = { get, update };
