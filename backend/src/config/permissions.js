// نظام الصلاحيات المركزي: المصدر الوحيد لما يستطيع كل دور فعله. لا فحوص أدوار متفرقة في الكود.
const ROLES = ["admin", "employee"];

const PERMISSIONS = Object.freeze([
  "models.read", "models.manage",
  "stock.receive", "stock.transfer", "stock.damage", "stock.adjust",
  "series.read", "movements.read",
  "invoices.read", "invoices.create", "invoices.cancel",
  "returns.read", "returns.create",
  "dashboard.view",
  "settings.read", "settings.manage",
  "reports.view",
  "costs.view", "costs.manage",
  "users.manage",
  "suppliers.manage",
  "finance.manage",
  "employees.read", "employees.manage",
  "payroll.read", "payroll.manage", "payroll.approve", "payroll.pay",
  "advances.read", "advances.manage", "advances.reverse",
]);

// للمالك فقط، ولا يمكن منحها لموظف مهما كانت إعدادات حسابه
const ADMIN_ONLY = Object.freeze(["models.manage", "settings.manage", "reports.view", "costs.view", "costs.manage", "users.manage", "suppliers.manage", "finance.manage",
  "employees.read", "employees.manage", "payroll.read", "payroll.manage", "payroll.approve", "payroll.pay", "advances.read", "advances.manage", "advances.reverse"]);
const GRANTABLE = Object.freeze(PERMISSIONS.filter((p) => !ADMIN_ONLY.includes(p)));

// الافتراضي للموظف الجديد (أدنى امتياز). الجرد (adjust) وإلغاء الفواتير يمنحهما المالك صراحةً
const EMPLOYEE_DEFAULTS = Object.freeze([
  "models.read", "stock.receive", "stock.transfer", "stock.damage", "series.read", "movements.read",
  "invoices.read", "invoices.create", "returns.read", "returns.create", "dashboard.view", "settings.read",
]);

// الصلاحيات الفعلية تُحسب دائماً من الدور والبيانات المخزَّنة على الخادم
function effectivePermissions(user) {
  if (user.role === "admin") return [...PERMISSIONS];
  const stored = Array.isArray(user.permissions) ? user.permissions : EMPLOYEE_DEFAULTS;
  return stored.filter((p) => GRANTABLE.includes(p));
}

module.exports = { ROLES, PERMISSIONS, ADMIN_ONLY, GRANTABLE, EMPLOYEE_DEFAULTS, effectivePermissions };
