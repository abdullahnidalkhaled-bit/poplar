const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/payroll.validation");
const c = require("../controllers/payroll.controller");

router.post("/", perm("payroll.manage"), validate(v.periodCreate), c.periodCreate);
router.get("/:id", perm("payroll.read"), validate(v.periodGet), c.periodGet);
router.get("/:id/summary", perm("payroll.read"), validate(v.periodGet), c.periodSummary);
router.post("/:id/adjustments", perm("payroll.manage"), validate(v.periodAdjust), c.periodAdjust);
router.post("/:id/adjustments/:entryId/reverse", perm("payroll.manage"), validate(v.entryReverse), c.periodAdjustReverse);
router.post("/:id/approve", perm("payroll.approve"), validate(v.periodAction), c.periodApprove);
router.post("/:id/payments", perm("payroll.pay"), validate(v.periodPay), c.periodPay);
router.post("/:id/payments/:entryId/reverse", perm("payroll.pay"), validate(v.entryReverse), c.periodPayReverse);
router.post("/:id/close", perm("payroll.approve"), validate(v.periodAction), c.periodClose);

module.exports = router;
