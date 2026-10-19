const finance = require("../services/finance.service");
const cash = require("../services/cash.service");
const { isSalaryCategory } = require("../utils/payroll");
const { forbidden } = require("../utils/errors");

const actor = (req) => ({ id: req.user.id, name: req.user.name });
const posted = (res, out) => res.success(out, out.duplicate ? 200 : 201);

module.exports = {
  dashboard: async (req, res) => res.success(await finance.dashboard(req.valid.query)),
  cashList: async (req, res) => res.success(await cash.listMovements(req.valid.query)),
  cashManual: async (req, res) => posted(res, await cash.manual(req.valid.body, actor(req))),
  cashReverse: async (req, res) => res.success(await cash.reverseManual(req.valid.params.id, req.valid.body, actor(req)), 201),
  expenseList: async (req, res) => res.success(await cash.listExpenses(req.valid.query)),
  expenseCreate: async (req, res) => {
    // مصروف الرواتب يتطلب صلاحية دفع الرواتب إضافةً إلى صلاحية المالية (الحماية على الخادم لا في الواجهة)
    const b = req.valid.body;
    if ((isSalaryCategory(b.category) || b.employeeId) && !req.user.permissions.has("payroll.pay")) throw forbidden();
    return posted(res, await cash.createExpense(b, actor(req)));
  },
  expenseReverse: async (req, res) => {
    // عكس مصروف راتب يتطلب صلاحية دفع الرواتب (نفس صلاحية إنشائه وصلاحية عكس الدفعة في واجهة الرواتب)، إضافةً إلى صلاحية المالية
    const existing = await cash.getExpense(req.valid.params.id);
    if (existing?.employeeId && !req.user.permissions.has("payroll.pay")) throw forbidden();
    return res.success(await cash.reverseExpense(req.valid.params.id, req.valid.body, actor(req)), 201);
  },
};
