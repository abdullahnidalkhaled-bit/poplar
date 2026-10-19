import { Link } from "react-router-dom";

export default function Forbidden() {
  return (
    <div className="empty" role="alert">
      <h1>غير مصرّح</h1>
      <p>ليست لديك صلاحية لفتح هذه الصفحة. إن كنت تحتاجها فاطلبها من مالك المتجر.</p>
      <Link className="btn primary" to="/">العودة إلى الرئيسية</Link>
    </div>
  );
}
