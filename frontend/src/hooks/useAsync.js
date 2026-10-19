import { useEffect, useState, useCallback, useRef } from "react";

// تحميل بيانات مع حالات loading/error وإلغاء الطلبات القديمة. reload() لإعادة التحميل
export default function useAsync(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let off = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef
      .current()
      .then((data) => !off && setState({ data, error: null, loading: false }))
      .catch((error) => !off && setState({ data: null, error, loading: false }));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
