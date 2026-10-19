import { Link } from "react-router-dom";
import ActionMenu from "./ActionMenu.jsx";

// ترويسة صفحة موحّدة: مسار تنقل اختياري + عنوان + وصف + إجراء رئيسي واحد + قائمة «المزيد» للإجراءات الثانوية
// crumbs: [{ to, label }] — العنصر الأخير نص فقط. primary: عنصر React. more: [{ label, onClick|to, danger }]
export default function PageHeader({ title, crumbs, sub, primary, more, children }) {
  return (
    <>
      {crumbs?.length > 0 && (
        <nav className="breadcrumb" aria-label="مسار التنقل">
          {crumbs.map((c, i) => (
            <span key={i}>{i > 0 && " / "}{c.to ? <Link to={c.to}>{c.label}</Link> : c.label}</span>
          ))}
        </nav>
      )}
      <div className="page-head">
        <div className="page-title">
          <h1>{title}</h1>
          {sub && <div className="muted small-note">{sub}</div>}
        </div>
        <div className="head-controls">
          {children}
          {primary}
          <ActionMenu items={more} />
        </div>
      </div>
    </>
  );
}
