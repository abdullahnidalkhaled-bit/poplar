import { useEffect, useRef, useId } from "react";

// نافذة حوار: Escape للإغلاق، تركيز تلقائي، وحصر Tab داخلها، وإعادة التركيز عند الإغلاق
export default function Modal({ title, onClose, children, wide }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    // لا تُنتزع من حقل طلب التركيز التلقائي (autoFocus) داخل النافذة؛ وإلا فالتركيز على النافذة نفسها
    if (node && !node.contains(document.activeElement)) node.focus();
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !node) return;
      const items = node.querySelectorAll('button, [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])');
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div ref={ref} tabIndex={-1} className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="إغلاق">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
