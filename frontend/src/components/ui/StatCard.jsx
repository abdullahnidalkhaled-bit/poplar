export default function StatCard({ label, value, hint, tone }) {
  return (
    <div className={`stat ${tone || ""}`}>
      <div className="muted">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="muted small-note">{hint}</div>}
    </div>
  );
}
