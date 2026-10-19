const router = require("express").Router();
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const v = require("../validations/supplier.validation");
const controller = require("../controllers/supplier.controller");

// حسابات التجار: للمالك فقط على مستوى الراوتر كله (المصادقة وCSRF مطبّقان قبله في routes/index.js)
router.use(requirePermission("suppliers.manage"));

// الثابتة قبل /:id
router.get("/summary", validate(v.summary), controller.summary);
router.get("/", validate(v.list), controller.list);
router.post("/", validate(v.create), controller.create);

router.get("/:id", validate(v.detail), controller.detail);
router.patch("/:id", validate(v.update), controller.update);

router.get("/:id/ledger", validate(v.ledger), controller.ledger);
router.get("/:id/invoices", validate(v.invoiceList), controller.invoices);
router.post("/:id/invoices", validate(v.createInvoice), controller.createInvoice);
router.post("/:id/payments", validate(v.payment), controller.payment);
router.post("/:id/advances", validate(v.advance), controller.advance);
router.post("/:id/adjustments", validate(v.adjustment), controller.adjustment);
router.post("/:id/entries/:entryId/reverse", validate(v.reverse), controller.reverse);

router.get("/:id/allocations", validate(v.allocationList), controller.allocations);
router.post("/:id/allocations", validate(v.allocate), controller.allocate);
router.post("/:id/allocations/auto", validate(v.autoAllocate), controller.autoAllocate);
router.post("/:id/allocations/:allocId/release", validate(v.releaseAllocation), controller.releaseAllocation);

router.get("/:id/settlements", validate(v.settlementList), controller.settlements);
router.get("/:id/settlements/eligible", validate(v.settlementEligible), controller.settlementEligible);
router.post("/:id/settlements", validate(v.settle), controller.settle);
router.post("/:id/settlements/:settlementId/reverse", validate(v.reverseSettlement), controller.reverseSettlement);
router.post("/:id/consignment/prices", validate(v.setPrice), controller.setPrice);

router.get("/:id/consignment", validate(v.consignment), controller.consignment);
router.get("/:id/returns", validate(v.returnList), controller.returns);
router.post("/:id/returns", validate(v.createReturn), controller.createReturn);

module.exports = router;
