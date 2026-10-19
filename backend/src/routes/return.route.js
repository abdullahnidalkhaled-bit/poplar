const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/return.validation");
const controller = require("../controllers/return.controller");

router.post("/", perm("returns.create"), validate(v.create), controller.create);
router.get("/", perm("returns.read"), validate(v.list), controller.list);

module.exports = router;
