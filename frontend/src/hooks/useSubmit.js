import { useRef, useState } from "react";

// إرسال نموذج مالي: حارس متزامن (ref) يمنع النقرات المتتالية قبل تحديث الحالة، ومفتاح تكرار يثبت طوال حياة النافذة
// فتُعاد المحاولة بالمفتاح نفسه بعد خطأ شبكة دون أي أثر مضاعف، ويتجدد بعد النجاح.
export default function useSubmit(onDone, makeKey) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const flight = useRef(false);
  const key = useRef(makeKey ? makeKey() : "");
  const run = async (fn) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      const out = await fn(key.current);
      if (makeKey) key.current = makeKey();
      onDone?.(out);
    } catch (e) {
      setError(e);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}
