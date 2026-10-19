import Modal from "./Modal.jsx";

// تأكيد قبل العمليات الخطرة (حذف/أرشفة/إلغاء)
export default function ConfirmDialog({ title, message, confirmLabel = "تأكيد", danger, busy, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{message}</p>
      <div className="actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>إلغاء</button>
        <button className={danger ? "btn danger" : "btn primary"} onClick={onConfirm} disabled={busy}>
          {busy ? "جارٍ التنفيذ..." : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
