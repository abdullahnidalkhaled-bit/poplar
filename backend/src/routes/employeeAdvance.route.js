const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/payroll.validation");
const c = require("../controllers/payroll.controller");

router.get("/", perm("advances.read"), validate(v.advList), c.advList);
router.post("/", perm("advances.manage"), validate(v.advCreate), c.advCreate);
router.post("/issue", perm("advances.manage"), validate(v.advIssue), c.advIssue);
router.get("/:id", perm("advances.read"), validate(v.advGet), c.advGet);
router.post("/:id/disburse", perm("advances.manage"), validate(v.advDisburse), c.advDisburse);
router.post("/:id/settlements", perm("advances.manage"), validate(v.advSettle), c.advSettle);
router.post("/:id/settlements/:entryId/reverse", perm("advances.reverse"), validate(v.entryReverse), c.advSettleReverse);
router.post("/:id/reversals", perm("advances.reverse"), validate(v.advReverse), c.advReverse);
router.post("/:id/reassign", perm("advances.manage"), validate(v.advReassign), c.advReassign);

module.exports = router;
