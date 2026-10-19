import { AVAILABILITY_LABEL } from "../../utils.js";

// الحالة تُعرض بنص ورمز ولون معاً (لا اعتماد على اللون وحده)
const ICON = { both: "✔", store_only: "●", warehouse_only: "▣", out_of_stock: "✖" };

export default function StockBadge({ size }) {
  return (
    <span className="status-stack">
      <span className={`status-badge ${size.availability}`}>
        <span aria-hidden="true">{ICON[size.availability]}</span> {AVAILABILITY_LABEL[size.availability]}
      </span>
    </span>
  );
}
