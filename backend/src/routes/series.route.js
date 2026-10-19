const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const v = require("../validations/series.validation");
const controller = require("../controllers/series.controller");

router.get("/", perm("series.read"), validate(v.list), controller.list);
router.get("/:seriesNo", perm("series.read"), validate(v.detail), controller.detail);

module.exports = router;
