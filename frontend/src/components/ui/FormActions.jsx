// أزرار نموذج موحّدة (إلغاء + إجراء رئيسي) لكل نماذج الإنشاء والتعديل: الترتيب والأنماط وحالة الحفظ واحدة
export default function FormActions({ onClose, busy, label, danger, disabled }) {
  return (
    <div className="actions">
      <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>إلغاء</button>
      <button className={danger ? "btn danger" : "btn primary"} disabled={busy || disabled}>{busy ? "جارٍ الحفظ..." : label}</button>
    </div>
  );
}
