const router = require("express").Router();
const mongoose = require("mongoose");
const { authenticate, csrfProtect } = require("../middleware/auth");

// تسجيل المسارات وبادئة كل مورد. العام الوحيد: /health و/auth/login (وبقية /auth تتحقق من الجلسة بنفسها).
// كل ما بعده يمرّ بالمصادقة ثم حماية CSRF؛ وكل مسار يعلن صلاحيته بـ requirePermission في ملفه.
router.get("/health", (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 ? "up" : "down" }));
router.use("/auth", require("./auth.route"));

router.use(authenticate, csrfProtect);

router.use("/users", require("./user.route"));
router.use("/suppliers", require("./supplier.route"));
router.use("/finance", require("./finance.route"));
router.use("/employees", require("./employee.route"));
router.use("/payroll-periods", require("./payrollPeriod.route"));
router.use("/employee-advances", require("./employeeAdvance.route"));
router.use("/models", require("./productModel.route"));
router.use("/series", require("./series.route"));
router.use("/stock", require("./stock.route"));
router.use("/movements", require("./movement.route"));
router.use("/invoices", require("./invoice.route"));
router.use("/returns", require("./return.route"));
router.use("/reports", require("./report.route"));
router.use("/settings", require("./setting.route"));
router.use("/", require("./lookup.route")); // /lookup و /qr/resolve

module.exports = router;
