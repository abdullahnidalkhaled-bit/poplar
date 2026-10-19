const BASE = import.meta.env.VITE_API_URL || "/api";

// خطأ API: يحمل رمز الخطأ وقائمة أخطاء الحقول لعرضها بجانب الحقول
export class ApiError extends Error {
  constructor(message, { status, code, errors } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors || [];
  }
  // رسالة الحقل المحدد (مثل "sizes.0.shopQty") إن وُجدت
  fieldError(field) {
    return this.errors.find((e) => e.field === field)?.message;
  }
}

// رمز CSRF في الذاكرة فقط (لا localStorage ولا كوكي يقرؤه JS). كوكي الجلسة HttpOnly ولا تراه الواجهة أصلاً
let csrfToken = "";
let onUnauthorized = null;
export const setCsrfToken = (t) => { csrfToken = t || ""; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(path, { method = "GET", body, auth = true } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(csrfToken && method !== "GET" ? { "x-csrf-token": csrfToken } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("تعذّر الاتصال بالخادم. تأكد أن الخادم يعمل وأن الشبكة متصلة.", { code: "NETWORK" });
  }
  const data = await res.json().catch(() => ({}));
  // جلسة منتهية أو مُسقطة (تعطيل الحساب/تغيير الصلاحيات): تعيد الواجهة إلى صفحة الدخول
  if (res.status === 401 && auth && onUnauthorized) onUnauthorized(data.message);
  if (!res.ok) throw new ApiError(data.message || "حدث خطأ غير متوقع", { status: res.status, code: data.code, errors: data.errors });
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: "POST", body }),
  put: (p, body) => request(p, { method: "PUT", body }),
  patch: (p, body) => request(p, { method: "PATCH", body }),
  // طلبات المصادقة نفسها: 401 فيها يعني بيانات خاطئة لا جلسة منتهية
  postAnon: (p, body) => request(p, { method: "POST", body, auth: false }),
  getAnon: (p) => request(p, { auth: false }),
  del: (p) => request(p, { method: "DELETE" }),
};

// يبني سلسلة استعلام ويتجاهل القيم الفارغة
export const qs = (params) => {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && v !== false && u.set(k, v));
  const s = u.toString();
  return s ? `?${s}` : "";
};
