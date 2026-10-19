const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/invoice.validation");
const controller = require("../controllers/invoice.controller");

router.post("/", perm("invoices.create"), validate(v.create), controller.create);
router.get("/", perm("invoices.read"), validate(v.list), controller.list);
router.get("/:id", perm("invoices.read"), validate(v.get), controller.get);
router.post("/:id/cancel", perm("invoices.cancel"), validate(v.cancel), controller.cancel);

module.exports = router;
