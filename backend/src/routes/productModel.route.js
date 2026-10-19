const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const present = require("../middleware/present.middleware");
const v = require("../validations/productModel.validation");
const controller = require("../controllers/productModel.controller");

// الترتيب مهم: المسارات الثابتة قبل /:modelNumber
router.get("/", perm("models.read"), validate(v.list), present("modelList"), controller.list);
router.get("/facets", perm("models.read"), validate(v.facets), controller.facets);
router.get("/next-number", perm("models.manage"), validate(v.suggestNumber), controller.suggestNumber);
router.post("/", perm("models.manage"), validate(v.create), present("model"), controller.create);
router.get("/:modelNumber", perm("models.read"), validate(v.get), present("model"), controller.get);
router.put("/:modelNumber", perm("models.manage"), validate(v.update), present("model"), controller.update);
router.delete("/:modelNumber", perm("models.manage"), validate(v.archive), present("model"), controller.archive);
router.post("/:modelNumber/restore", perm("models.manage"), validate(v.restore), present("model"), controller.restore);
router.get("/:modelNumber/qr", perm("models.read"), validate(v.qr), controller.qr);

module.exports = router;