// قاعدة التنبيه الوحيدة للمخزون (تستعملها availability.service وعارض النموذج في middleware/presenters)
//  - المحل صفر + المستودع > 0  => canTransfer (انقل من المستودع، لا تطلب شحنة)
//  - صفر في الموقعين            => isOut (اطلب شحنة)
//  - كمية 1 أو أكثر في المحل    => لا تنبيه
const qty = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0);

const isOut = (shop, warehouse) => qty(shop) + qty(warehouse) === 0;
const canTransfer = (shop, warehouse) => qty(shop) === 0 && qty(warehouse) > 0;

module.exports = { qty, isOut, canTransfer };
