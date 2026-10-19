const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/movement.validation");
const controller = require("../controllers/movement.controller");

router.get("/", perm("movements.read"), validate(v.list), controller.list);

module.exports = router;
