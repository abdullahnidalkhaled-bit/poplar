const suppliers = require("../services/supplier.service");
const ledger = require("../services/supplierLedger.service");
const returns = require("../services/supplierReturn.service");
const settlements = require("../services/supplierSettlement.service");

// الخدمات تستلم هوية المنفّذ (للتدقيق فقط) من الجلسة لا من الطلب
const actor = (req) => ({ id: req.user.id, name: req.user.name });
const posted = (res, out) => res.success(out, out.duplicate ? 200 : 201);

module.exports = {
  summary: async (req, res) => res.success(await suppliers.summary()),
  list: async (req, res) => res.success(await suppliers.list(req.valid.query)),
  create: async (req, res) => res.success(await suppliers.create(req.valid.body), 201),
  detail: async (req, res) => res.success(await suppliers.detail(req.valid.params.id)),
  update: async (req, res) => res.success(await suppliers.update(req.valid.params.id, req.valid.body)),

  ledger: async (req, res) => res.success(await ledger.statement(req.valid.params.id, req.valid.query)),
  invoices: async (req, res) => res.success(await ledger.listInvoices(req.valid.params.id)),
  createInvoice: async (req, res) => posted(res, await ledger.createInvoice(req.valid.params.id, req.valid.body, actor(req))),
  payment: async (req, res) => posted(res, await ledger.recordPayment(req.valid.params.id, req.valid.body, actor(req))),
  advance: async (req, res) => posted(res, await ledger.recordAdvance(req.valid.params.id, req.valid.body, actor(req))),
  adjustment: async (req, res) => posted(res, await ledger.recordAdjustment(req.valid.params.id, req.valid.body, actor(req))),
  reverse: async (req, res) => res.success(await ledger.reverseEntry(req.valid.params.id, req.valid.params.entryId, req.valid.body, actor(req)), 201),

  allocations: async (req, res) => res.success(await ledger.listAllocations(req.valid.params.id)),
  allocate: async (req, res) => posted(res, await ledger.allocate(req.valid.params.id, req.valid.body, actor(req))),
  autoAllocate: async (req, res) => res.success(await ledger.autoAllocate(req.valid.params.id, req.valid.body, actor(req)), 201),
  releaseAllocation: async (req, res) => res.success(await ledger.releaseAllocation(req.valid.params.id, req.valid.params.allocId, req.valid.body, actor(req)), 201),
  settlements: async (req, res) => res.success(await settlements.list(req.valid.params.id)),
  settlementEligible: async (req, res) => res.success(await settlements.eligible(req.valid.params.id)),
  settle: async (req, res) => posted(res, await settlements.post(req.valid.params.id, req.valid.body, actor(req))),
  reverseSettlement: async (req, res) => res.success(await settlements.reverse(req.valid.params.id, req.valid.params.settlementId, req.valid.body, actor(req)), 201),
  setPrice: async (req, res) => res.success(await settlements.setPrices(req.valid.params.id, req.valid.body, actor(req)), 201),

  consignment: async (req, res) => res.success(await returns.consignment(req.valid.params.id, req.valid.query)),
  returns: async (req, res) => res.success(await returns.listReturns(req.valid.params.id)),
  createReturn: async (req, res) => posted(res, await returns.createReturn(req.valid.params.id, req.valid.body, actor(req))),
};
