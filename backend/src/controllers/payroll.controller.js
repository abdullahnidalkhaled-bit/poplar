const employees = require("../services/employee.service");
const payroll = require("../services/payroll.service");
const advances = require("../services/employeeAdvance.service");
const ledger = require("../services/employeeLedger.service");
const finance = require("../services/employeeFinance.service");

const actor = (req) => ({ id: req.user.id, name: req.user.name });
// عملية مالية مرحَّلة: 201 للجديدة و200 لإعادة طلب سبق تنفيذه بنفس المفتاح (لا أثر جديداً)
const posted = (res, out) => res.success(out, out.duplicate ? 200 : 201);

module.exports = {
  empList: async (req, res) => res.success(await employees.list(req.valid.query)),
  empCreate: async (req, res) => res.success(await employees.create(req.valid.body, actor(req)), 201),
  empGet: async (req, res) => res.success(await employees.get(req.valid.params.id)),
  empUpdate: async (req, res) => res.success(await employees.update(req.valid.params.id, req.valid.body, actor(req))),
  empAccount: async (req, res) => res.success(await employees.account(req.valid.params.id, req.valid.query.period)),
  empPeriods: async (req, res) => res.success(await payroll.listForEmployee(req.valid.params.id, req.valid.query)),
  empLedger: async (req, res) => res.success(await ledger.list(req.valid.params.id, req.valid.query)),

  empSummary: async (req, res) => res.success(await finance.summary(req.valid.params.id, req.valid.query.period)),
  empAdjust: async (req, res) => posted(res, await finance.addAdjustment(req.valid.params.id, req.valid.body, actor(req))),
  empSettle: async (req, res) => res.success(await finance.applyScheduledSettlements(req.valid.params.id, req.valid.body, actor(req))),
  empClosePeriod: async (req, res) => res.success(await finance.closePeriod(req.valid.params.id, req.valid.body, actor(req))),
  advIssue: async (req, res) => posted(res, await finance.issueAdvance(req.valid.body, actor(req))),

  periodCreate: async (req, res) => posted(res, await payroll.createPeriod(req.valid.body, actor(req))),
  periodGet: async (req, res) => res.success(await payroll.get(req.valid.params.id)),
  periodSummary: async (req, res) => res.success(await payroll.summary(req.valid.params.id)),
  periodApprove: async (req, res) => res.success(await payroll.approve(req.valid.params.id, actor(req))),
  periodAdjust: async (req, res) => posted(res, await payroll.addAdjustment(req.valid.params.id, req.valid.body, actor(req))),
  periodAdjustReverse: async (req, res) => res.success(await payroll.reverseAdjustment(req.valid.params.id, req.valid.params.entryId, req.valid.body, actor(req)), 201),
  periodPay: async (req, res) => posted(res, await finance.payPeriod(req.valid.params.id, req.valid.body, actor(req))),
  periodPayReverse: async (req, res) => res.success(await payroll.reversePayment(req.valid.params.id, req.valid.params.entryId, req.valid.body, actor(req)), 201),
  periodClose: async (req, res) => {
    const p = await payroll.loadPeriod(req.valid.params.id);
    res.success(await finance.closePeriod(String(p.employee), { periodKey: p.periodKey }, actor(req)));
  },

  advList: async (req, res) => res.success(await advances.list(req.valid.query)),
  advCreate: async (req, res) => posted(res, await advances.create(req.valid.body, actor(req))),
  advGet: async (req, res) => res.success(await advances.get(req.valid.params.id)),
  advDisburse: async (req, res) => posted(res, await advances.disburse(req.valid.params.id, req.valid.body, actor(req))),
  advSettle: async (req, res) => posted(res, await advances.settle(req.valid.params.id, req.valid.body, actor(req))),
  advSettleReverse: async (req, res) => res.success(await advances.reverseSettlement(req.valid.params.id, req.valid.params.entryId, req.valid.body, actor(req)), 201),
  advReverse: async (req, res) => res.success(await advances.reverse(req.valid.params.id, req.valid.body, actor(req)), 201),
  advReassign: async (req, res) => posted(res, await advances.reassign(req.valid.params.id, req.valid.body, actor(req))),
};
