// حقل نموذج: تسمية + تلميح + رسالة خطأ مقروءة لقارئات الشاشة
export default function Field({ label, error, hint, children, className = "", required }) {
  return (
    <label className={`field ${error ? "has-error" : ""} ${className}`}>
      <span className="field-label">{label}{required && <span className="req" aria-hidden="true"> *</span>}</span>
      {children}
      {hint && !error && <span className="small-note muted">{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}
