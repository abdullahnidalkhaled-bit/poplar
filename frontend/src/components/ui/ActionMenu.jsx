import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

// قائمة «المزيد»: تجمع الإجراءات الثانوية. Escape والنقر خارجها يغلقانها، وأسهم لأعلى/لأسفل للتنقل
// items: [{ label, onClick? , to?, danger?, hidden? }]
export default function ActionMenu({ items, label = "المزيد" }) {
  const list = (items || []).filter((i) => i && !i.hidden);
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const els = [...root.current.querySelectorAll('[role="menuitem"]')];
      const at = els.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (at + 1) % els.length : (at - 1 + els.length) % els.length;
      e.preventDefault();
      els[next]?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    root.current.querySelector('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);

  if (list.length === 0) return null;
  return (
    <div className="action-menu" ref={root}>
      <button type="button" className="btn ghost" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {label}
        <svg viewBox="0 0 12 8" width="12" height="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 1.5l5 5 5-5" /></svg>
      </button>
      {open && (
        <div className="menu" id={id} role="menu">
          {list.map((it, i) => {
            const cls = it.danger ? "menu-item danger" : "menu-item";
            return it.to
              ? <Link key={i} role="menuitem" className={cls} to={it.to} onClick={() => setOpen(false)}>{it.label}</Link>
              : <button key={i} type="button" role="menuitem" className={cls} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>;
          })}
        </div>
      )}
    </div>
  );
}
