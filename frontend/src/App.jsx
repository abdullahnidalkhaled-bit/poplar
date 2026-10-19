import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "./api.js";
import { AuthProvider, useAuth } from "./auth.jsx";
import Login from "./pages/Login.jsx";
import Forbidden from "./pages/Forbidden.jsx";
import Users from "./pages/Users.jsx";
import Suppliers from "./pages/Suppliers.jsx";
import Employees from "./pages/Employees.jsx";
import EmployeeAccount from "./pages/EmployeeAccount.jsx";
import Finance from "./pages/Finance.jsx";
import SupplierDetail from "./pages/SupplierDetail.jsx";
import AppShell from "./components/layout/AppShell.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Models from "./pages/Models.jsx";
import ModelDetail from "./pages/ModelDetail.jsx";
import ModelForm from "./pages/ModelForm.jsx";
import ReceiveShipment from "./pages/ReceiveShipment.jsx";
import Scan from "./pages/Scan.jsx";
import Movements from "./pages/Movements.jsx";
import InventoryLog from "./pages/InventoryLog.jsx";
import Cashier from "./pages/Cashier.jsx";
import Invoices from "./pages/Invoices.jsx";
import Reports from "./pages/Reports.jsx";
import Settings from "./pages/Settings.jsx";

// بوابة واجهة فقط (للراحة): الحماية الفعلية على الخادم. من لا يملك الصلاحية يرى صفحة "غير مصرّح"
const Guard = ({ perm, children }) => (useAuth().can(perm) ? children : <Forbidden />);

// الصفحة الرئيسية: اللوحة إن سُمح بها، وإلا أول صفحة مسموحة للمستخدم
function Home() {
  const { can } = useAuth();
  if (can("dashboard.view")) return <Dashboard />;
  const first = [["invoices.create", "/cashier"], ["models.read", "/models"], ["stock.receive", "/receive"], ["invoices.read", "/invoices"]].find(([p]) => can(p));
  return first ? <Navigate to={first[1]} replace /> : <Forbidden />;
}

// /payroll/:id القديم → /employees/:id مع الاحتفاظ بالشهر المطلوب
function LegacyEmployeeRedirect() {
  const { id } = useParams();
  const loc = useLocation();
  return <Navigate to={`/employees/${id}${loc.search}`} replace />;
}

function Routed() {
  const { can } = useAuth();
  const [settings, setSettings] = useState(null);
  const [serverError, setServerError] = useState("");
  const [exchange, setExchange] = useState(null);
  const loc = useLocation();
  const nav = useNavigate();

  const loadSettings = useCallback(() => {
    if (!can("settings.read")) return;
    api.get("/settings").then((s) => { setSettings(s); setServerError(""); }).catch((e) => setServerError(e.message));
  }, [can]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const startExchange = (ex) => { setExchange(ex); nav("/cashier"); };
  const onCashier = loc.pathname === "/cashier";

  return (
    <AppShell settings={settings} serverError={serverError}>
      {/* الكاشير يبقى محمّلاً (مخفياً) كي لا تضيع السلة عند التنقل */}
      {can("invoices.create") && (
        <div hidden={!onCashier}>
          <Cashier settings={settings} active={onCashier} exchange={exchange} onExchangeEnd={() => setExchange(null)} />
        </div>
      )}
      {onCashier && !can("invoices.create") && <Forbidden />}
      {!onCashier && (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/models" element={<Guard perm="models.read"><Models /></Guard>} />
          <Route path="/models/new" element={<Guard perm="models.manage"><ModelForm mode="create" /></Guard>} />
          <Route path="/models/:modelNumber" element={<Guard perm="models.read"><ModelDetail /></Guard>} />
          <Route path="/models/:modelNumber/edit" element={<Guard perm="models.manage"><ModelForm mode="edit" /></Guard>} />
          <Route path="/receive" element={<Guard perm="stock.receive"><ReceiveShipment /></Guard>} />
          <Route path="/scan" element={<Guard perm="models.read"><Scan /></Guard>} />
          <Route path="/series" element={<Guard perm="series.read"><InventoryLog /></Guard>} />
          <Route path="/movements" element={<Guard perm="movements.read"><Movements /></Guard>} />
          <Route path="/invoices" element={<Guard perm="invoices.read"><Invoices rate={settings?.usdToSyp || 0} onStartExchange={startExchange} /></Guard>} />
          <Route path="/reports" element={<Guard perm="reports.view"><Reports /></Guard>} />
          <Route path="/settings" element={<Guard perm="settings.manage"><Settings settings={settings} onSaved={setSettings} /></Guard>} />
          <Route path="/users" element={<Guard perm="users.manage"><Users /></Guard>} />
          <Route path="/finance" element={<Guard perm="finance.manage"><Finance /></Guard>} />
          <Route path="/employees" element={<Guard perm="employees.read"><Employees /></Guard>} />
          <Route path="/employees/:id" element={<Guard perm="payroll.read"><EmployeeAccount /></Guard>} />
          {/* مسارات صفحة الرواتب والسلف القديمة: تُحوَّل إلى حساب الموظف (الصفحة المستقلة أُلغيت) */}
          <Route path="/payroll" element={<Navigate to="/employees" replace />} />
          <Route path="/payroll/:id" element={<LegacyEmployeeRedirect />} />
          <Route path="/suppliers" element={<Guard perm="suppliers.manage"><Suppliers /></Guard>} />
          <Route path="/suppliers/:id" element={<Guard perm="suppliers.manage"><SupplierDetail /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </AppShell>
  );
}

// بوابة الدخول: لا يُحمَّل أي شيء من التطبيق قبل التحقق من الجلسة
function Gate() {
  const { status } = useAuth();
  if (status === "loading") return <div className="splash"><span className="spinner" aria-label="جارٍ التحميل" /></div>;
  if (status === "anon") return <Login />;
  return <Routed />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
