const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const v = require("../validations/finance.validation");
const controller = require("../controllers/finance.controller");

// المالية (صندوقا الليرة والدولار، المصروفات، لوحة الأرباح): للمالك فقط على مستوى الراوتر كله
router.use(requirePermission("finance.manage"));

router.get("/dashboard", validate(v.dashboard), controller.dashboard);
router.get("/cash", validate(v.cashList), controller.cashList);
router.post("/cash", validate(v.cashManual), controller.cashManual);
router.post("/cash/:id/reverse", validate(v.cashReverse), controller.cashReverse);
router.get("/expenses", validate(v.expenseList), controller.expenseList);
router.post("/expenses", validate(v.expenseCreate), controller.expenseCreate);
router.post("/expenses/:id/reverse", validate(v.expenseReverse), controller.expenseReverse);

module.exports = router;
