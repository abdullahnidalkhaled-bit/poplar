const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm, forbidFieldsWithout } = require("../middleware/auth");
const present = require("../middleware/present.middleware");
const v = require("../validations/stock.validation");
const controller = require("../controllers/stock.controller");

router.post("/receive", perm("stock.receive"), forbidFieldsWithout("costs.manage", ["unitCostUsd"]), forbidFieldsWithout("suppliers.manage", ["supplierId", "consignment", "consignmentPrice", "purchase"], "ربط الشحنة بتاجر أو بضاعة أمانة للمالك فقط."), validate(v.receive), present("stockResult"), controller.receive);
router.post("/transfer", perm("stock.transfer"), validate(v.transfer), present("stockResult"), controller.transfer);
router.post("/damage", perm("stock.damage"), validate(v.damage), present("stockResult"), controller.damage);
router.post("/adjust", perm("stock.adjust"), validate(v.adjust), present("stockResult"), controller.adjust);

module.exports = router;
