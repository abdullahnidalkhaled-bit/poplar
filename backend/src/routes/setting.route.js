const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/setting.validation");
const controller = require("../controllers/setting.controller");

router.get("/", perm("settings.read"), validate(v.get), controller.get);
router.put("/", perm("settings.manage"), validate(v.update), controller.update);

module.exports = router;
