// حالات موحّدة: تحميل / خطأ / فراغ / تنبيه
export const Loading = ({ label = "جارٍ التحميل..." }) => (
  <p className="muted loading" role="status"><span className="spinner" aria-hidden="true" /> {label}</p>
);

export const ErrorBanner = ({ error, onRetry }) =>
  error ? (
    <div className="banner error" role="alert">
      <span>{error.message || String(error)}</span>
      {onRetry && <button className="btn small ghost" onClick={onRetry}>إعادة المحاولة</button>}
    </div>
  ) : null;

export const EmptyState = ({ title, text, children }) => (
  <div className="empty">
    <p className="empty-title">{title}</p>
    {text && <p className="muted">{text}</p>}
    {children}
  </div>
);

export const Alert = ({ tone = "info", title, children, action }) => (
  <div className={`alert ${tone}`} role={tone === "danger" ? "alert" : "status"}>
    <span className="alert-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {tone === "ok" ? <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l3 3 5-6" /></>
          : tone === "info" ? <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>
          : <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></>}
      </svg>
    </span>
    <div className="alert-body">
      {title && <b>{title}</b>}
      <div>{children}</div>
    </div>
    {action}
  </div>
);
