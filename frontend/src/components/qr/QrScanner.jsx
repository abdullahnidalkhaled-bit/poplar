import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// ماسح QR بالكاميرا (jsQR). يوقف الكاميرا تلقائياً عند الإغلاق، ويتعامل مع رفض الإذن وغياب الكاميرا
export default function QrScanner({ onResult }) {
  const video = useRef(null);
  const canvas = useRef(document.createElement("canvas"));
  const [status, setStatus] = useState("starting");
  const [message, setMessage] = useState("");
  const last = useRef({ code: "", at: 0 });
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let stream;
    let raf;
    let stopped = false;

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        return setMessage("الكاميرا غير متاحة. المسح بالكاميرا يتطلب اتصالاً آمناً (https) أو localhost. يمكنك استخدام حقل الإدخال أو جهاز ماسح.");
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        video.current.srcObject = stream;
        await video.current.play();
        setStatus("scanning");
        tick();
      } catch (e) {
        setStatus("error");
        setMessage(e.name === "NotAllowedError" ? "تم رفض إذن الكاميرا. اسمح بالوصول من إعدادات المتصفح." : e.name === "NotFoundError" ? "لا توجد كاميرا في هذا الجهاز." : "تعذّر تشغيل الكاميرا.");
      }
    };

    const tick = () => {
      const v = video.current;
      if (stopped || !v) return;
      if (v.readyState === v.HAVE_ENOUGH_DATA) {
        const c = canvas.current;
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        const now = Date.now();
        if (found?.data && (found.data !== last.current.code || now - last.current.at > 2500)) {
          last.current = { code: found.data, at: now };
          cb.current(found.data);
        }
      }
      raf = setTimeout(() => requestAnimationFrame(tick), 120); // ~8 إطارات/ثانية تكفي وتوفر المعالج
    };

    start();
    return () => {
      stopped = true;
      clearTimeout(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scanner">
      {status !== "error" && (
        <div className="scanner-frame">
          <video ref={video} muted playsInline aria-label="معاينة الكاميرا" />
          <span className="scanner-guide" aria-hidden="true" />
          {status === "starting" && <span className="scanner-msg">جارٍ تشغيل الكاميرا...</span>}
        </div>
      )}
      {status === "error" && <div className="banner warn" role="alert">{message}</div>}
    </div>
  );
}
