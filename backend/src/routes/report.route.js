const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/report.validation");
const controller = require("../controllers/report.controller");

router.get("/dashboard", perm("dashboard.view"), validate(v.dashboard), controller.dashboard);
router.get("/inventory", perm("reports.view"), validate(v.inventory), controller.inventory);
router.get("/summary", perm("reports.view"), validate(v.summary), controller.summary);

module.exports = router;
