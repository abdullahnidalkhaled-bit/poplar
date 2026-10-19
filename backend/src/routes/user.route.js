const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const v = require("../validations/user.validation");
const controller = require("../controllers/user.controller");

// إدارة الحسابات: للمالك فقط. الدور لا يُقبل من الطلب إطلاقاً (الإنشاء ينتج موظفاً دائماً)
router.use(requirePermission("users.manage"));

router.get("/", validate(v.list), controller.list);
router.post("/", validate(v.create), controller.create);
router.patch("/:id", validate(v.update), controller.update);
router.post("/:id/reset-password", validate(v.resetPassword), controller.resetPassword);

module.exports = router;
