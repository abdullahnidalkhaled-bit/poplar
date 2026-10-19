const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission: perm } = require("../middleware/auth");
const present = require("../middleware/present.middleware");
const v = require("../validations/lookup.validation");
const controller = require("../controllers/lookup.controller");

// الرموز: منطق واحد للماسح والبحث والكاشير. المسارات كاملة هنا لأن للمورد بادئتين (/lookup و/qr)
router.get("/lookup", perm("models.read"), validate(v.lookup), present("lookup"), controller.lookup);
router.post("/qr/resolve", perm("models.read"), validate(v.resolveQr), present("lookup"), controller.resolveQr);

module.exports = router;
