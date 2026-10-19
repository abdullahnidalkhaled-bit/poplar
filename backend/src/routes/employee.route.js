const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/payroll.validation");
const c = require("../controllers/payroll.controller");

// ملفات الموظفين الماليين وحساباتهم (الرواتب والسلف): صلاحيات ضيّقة لكل عملية، وكلها للمالك افتراضياً
router.get("/", perm("employees.read"), validate(v.empList), c.empList);
router.post("/", perm("employees.manage"), validate(v.empCreate), c.empCreate);
router.get("/:id", perm("employees.read"), validate(v.empGet), c.empGet);
router.patch("/:id", perm("employees.manage"), validate(v.empUpdate), c.empUpdate);
router.get("/:id/account", perm("payroll.read"), validate(v.empAccount), c.empAccount);
router.get("/:id/payroll-periods", perm("payroll.read"), validate(v.empPeriods), c.empPeriods);
router.get("/:id/payroll-summary", perm("payroll.read"), validate(v.summaryQ), c.empSummary);
router.post("/:id/adjustments", perm("payroll.manage"), validate(v.empAdjust), c.empAdjust);
router.post("/:id/settle-advances", perm("advances.manage"), validate(v.empPeriodAction), c.empSettle);
router.post("/:id/close-period", perm("payroll.approve"), validate(v.empClose), c.empClosePeriod);
router.get("/:id/ledger", perm("payroll.read"), validate(v.empLedger), c.empLedger);

module.exports = router;
