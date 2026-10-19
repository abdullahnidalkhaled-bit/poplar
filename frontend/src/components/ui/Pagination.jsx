export default function Pagination({ page, pages, total, onChange }) {
  if (!total) return null;
  return (
    <nav className="pagination" aria-label="ترقيم الصفحات">
      <button className="btn small ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>السابق</button>
      <span className="muted">صفحة {page} من {pages} · {total.toLocaleString("en-US")} نتيجة</span>
      <button className="btn small ghost" disabled={page >= pages} onClick={() => onChange(page + 1)}>التالي</button>
    </nav>
  );
}
