import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../../auth.jsx";

const Icon = ({ d }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p, i) => <path key={i} d={p} />)}
  </svg>
);

const NAV = [
  { to: "/", label: "اللوحة", end: true, perm: "dashboard.view", d: ["M3 12l9-8 9 8", "M5 10v10h14V10"] },
  { to: "/models", label: "الموديلات", perm: "models.read", d: ["M21 8l-9-5-9 5v8l9 5 9-5z", "M3 8l9 5 9-5", "M12 13v8"] },
  { to: "/receive", label: "استلام شحنة", perm: "stock.receive", d: ["M12 3v12", "M7 10l5 5 5-5", "M4 21h16"] },
  { to: "/scan", label: "مسح QR", perm: "models.read", d: ["M4 8V5a1 1 0 011-1h3", "M16 4h3a1 1 0 011 1v3", "M20 16v3a1 1 0 01-1 1h-3", "M8 20H5a1 1 0 01-1-1v-3", "M8 12h8"] },
  { to: "/series", label: "سجل الأرتال", perm: "series.read", d: ["M4 7h16M4 12h16M4 17h16", "M8 4v16"] },
  { to: "/movements", label: "سجل الحركات", perm: "movements.read", d: ["M3 6h18M3 12h18M3 18h12"] },
  { to: "/cashier", label: "الكاشير", perm: "invoices.create", d: ["M4 5v14M7 5v14M11 5v14M14 5v14M18 5v14M20 5v14"] },
  { to: "/invoices", label: "الفواتير", perm: "invoices.read", d: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6M9 12h6"] },
  { to: "/reports", label: "التقارير", perm: "reports.view", d: ["M4 20V10M10 20V4M16 20v-7M22 20H2"] },
  { to: "/settings", label: "الإعدادات", perm: "settings.manage", d: ["M12 15a3 3 0 100-6 3 3 0 000 6z", "M12 2v3M12 19v3M2 12h3M19 12h3"] },
  { to: "/finance", label: "المالية", perm: "finance.manage", d: ["M3 6h18v12H3z", "M12 9v6", "M9.5 10.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4"] },
  { to: "/suppliers", label: "حسابات التجار", perm: "suppliers.manage", d: ["M3 7h18v12H3z", "M3 11h18", "M7 15h3"] },
  { to: "/employees", label: "الموظفون", perm: "employees.read", d: ["M16 8a4 4 0 11-8 0 4 4 0 018 0z", "M4 21a8 8 0 0116 0"] },
];

// أهم الوجهات للشريط السفلي في الجوال (تُعرض المسموح منها فقط، بحد أقصى 4)
// مجموعات القائمة الجانبية (الترتيب داخل المجموعة كما في NAV)
const GROUPS = [
  ["المبيعات", ["/cashier", "/invoices"]],
  ["المخزون", ["/", "/models", "/receive", "/scan", "/series", "/movements"]],
  ["الإدارة", ["/finance", "/suppliers", "/employees", "/reports", "/settings"]],
];
const QUICK = ["/", "/cashier", "/models", "/scan", "/invoices"];
const MENU = ["M4 6h16", "M4 12h16", "M4 18h16"];

export default function AppShell({ settings, serverError, children }) {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  const items = NAV.filter((n) => can(n.perm));
  const quick = QUICK.map((to) => items.find((n) => n.to === to)).filter(Boolean).slice(0, 4);
  const rate = settings?.usdToSyp > 0 ? `1$ = ${settings.usdToSyp.toLocaleString("en-US")} ل.س` : null;

  // إغلاق القائمة عند التنقل أو Escape، وقفل التمرير خلفها
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">تخطَّ إلى المحتوى</a>

      <aside id="sidebar" className={open ? "sidebar open" : "sidebar"}>
        <div className="wordmark">Poplar.tr<small>إدارة المتجر والجرد</small></div>
        <nav className="nav" aria-label="التنقل الرئيسي">
          {GROUPS.map(([title, tos]) => {
            const group = tos.map((to) => items.find((n) => n.to === to)).filter(Boolean);
            return group.length === 0 ? null : (
              <div key={title} role="group" aria-label={title}>
                <div className="nav-group" aria-hidden="true">{title}</div>
                {group.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "tab active" : "tab")}>
                    <Icon d={n.d} />{n.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="rate">
            {rate ? <>سعر الصرف<b>{rate}</b></> : "سعر الصرف غير محدد"}
          </div>
          <div className="sidebar-user">
            <span><small>{user?.role === "admin" ? "المالك" : "موظف"}</small><b>{user?.name}</b></span>
            <button className="btn small ghost" onClick={logout}>خروج</button>
          </div>
        </div>
      </aside>
      <div className={open ? "drawer-backdrop open" : "drawer-backdrop"} onClick={() => setOpen(false)} aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <span className="brand">Poplar.tr</span>
          {rate && <span className="topbar-rate">{rate}</span>}
        </header>
        {serverError && <div className="banner error" role="alert">{serverError}</div>}
        <main className="page" id="main">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="تنقل سريع">
        {quick.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : undefined)}>
            <Icon d={n.d} /><span>{n.label}</span>
          </NavLink>
        ))}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidebar">
          <Icon d={MENU} /><span>المزيد</span>
        </button>
      </nav>
    </div>
  );
}
