import StockBadge from "../ui/StockBadge.jsx";
import { FACTORY_WARNING } from "../../utils.js";

// جدول المقاسات: كل المقاسات (حتى الصفرية) بكمية المحل والمستودع والإجمالي والحالة
export default function SizeTable({ sizes, highlight, renderActions }) {
  return (
    <div className="table-wrap">
      <table className="table-cards size-table">
        <caption className="sr-only">كميات المخزون حسب المقاس</caption>
        <thead>
          <tr>
            <th scope="col">المقاس</th>
            <th scope="col" className="num">المحل</th>
            <th scope="col" className="num">المستودع</th>
            <th scope="col" className="num">الإجمالي</th>
            <th scope="col">الحالة</th>
            {renderActions && <th scope="col"><span className="sr-only">إجراءات</span></th>}
          </tr>
        </thead>
        <tbody>
          {sizes.map((s) => (
            <tr key={s.size} className={highlight === s.size ? "row-highlight" : ""}>
              <th scope="row" data-label="المقاس"><span className="size-chip">{s.size}</span></th>
              <td className="num" data-label="المحل">{s.shopQty}</td>
              <td className="num" data-label="المستودع">{s.warehouseQty}</td>
              <td className="num strong" data-label="الإجمالي">{s.totalQty}</td>
              <td data-label="الحالة" className="status-cell-wide">
                <StockBadge size={s} />
                {s.needsFactoryRestock && <div className="size-note danger-text">{FACTORY_WARNING}</div>}
                {s.canTransfer && <div className="size-note">متوفر في المستودع ({s.warehouseQty}): يمكن نقله إلى المحل للعرض والبيع.</div>}
              </td>
              {renderActions && <td className="row-actions">{renderActions(s)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
