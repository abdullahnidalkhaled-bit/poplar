/*
 * بيانات التطوير الوهمية (قاعدة MongoDB المحلية القابلة للمسح): تمرّ كلها عبر طبقة الخدمات الحقيقية (FIFO، الأرتال، الحركات،
 * الفواتير، المرتجعات، الصندوقان، دفتر الموردين، التسويات)، فلا تُكتب أرقام مصطنعة تخالف قواعد النظام. الأسماء وأرقام الهواتف خيالية.
 *
 * سير العمل الموثّق لإعادة بناء قاعدة التطوير (أوامر تنفَّذ من backend):
 *   npm run reset-dev -- --confirm-db=<الاسم> [--mark-disposable]     مسح القاعدة بالكامل (بوابة أمان)
 *   npm run migrate:suppliers -- --apply                             الترحيل: المجموعات والفهارس لكل النماذج
 *   npm run seed -- --confirm-db=<الاسم>                             هذا السكربت
 *
 * أمان: يمرّ بنفس بوابة scripts/lib/safety.js (محلي، غير إنتاج، اسم مُؤكَّد، موسوم قابلاً للمسح، بلا مجموعات غريبة).
 * مع --reset يمسح محتوى مجموعات المشروع ثم يعيد البناء؛ وإعادة التشغيل تنتج البيانات نفسها (مفاتيح تكرار حتمية). بعد البناء يُشغَّل
 * فحص سلامة مستقل يعيد اشتقاق أرصدة الصندوقين من المصادر ويرفض أي تناقض.
 */
const mongoose = require("mongoose");
const env = require("../src/config/env");
const { preflight, assertDisposable } = require("./lib/safety");
const { verifyIntegrity } = require("./lib/verify");

const ARGS = new Set(process.argv.slice(2));
// --keep-users: لا يُمَسّ أي شيء من الحسابات (users) ولا الجلسات ولا الإعدادات؛ كل ما عدا ذلك يُمسح ويُعاد بناؤه
const KEEP = ARGS.has("--keep-users");
const ADMIN = { name: "المالك", username: "admin", password: "Poplar-Local-2026!" };
const STAFF = [
  { name: "سارة الأحمد", username: "sara", password: "Shop-Staff-2026" },
  { name: "عمر الخطيب", username: "omar", password: "Stock-Keeper-2026", permissions: ["models.read", "stock.receive", "stock.transfer", "stock.damage", "stock.adjust", "series.read", "movements.read", "invoices.read", "invoices.create", "invoices.cancel", "returns.read", "returns.create", "dashboard.view", "settings.read"] },
  { name: "لينا (كاشير)", username: "lina", password: "Cashier-Desk-2026", permissions: ["models.read", "invoices.create", "returns.create", "settings.read"] },
];

const day = 86_400_000;
const pad = (n, w = 3) => String(n).padStart(w, "0");
const barcode = (m, i) => `62910${pad(m, 2)}${pad(i, 5)}`;
const series = (qtyBySize) => ({ sizes: Object.entries(qtyBySize).map(([size, qty]) => ({ size, qty })) });

const MODELS = [
  { modelNumber: "FAF-001", name: "بنطال بوت كات", brand: "FAF", origin: "local", type: "بنطال", cut: "بوت كات", season: "صيف 2026", costPrice: 22, sellPrice: 45, sizes: ["S", "M", "L", "XL"], notes: "جينز أزرق غامق" },
  { modelNumber: "FAF-002", name: "بنطال سكيني", brand: "FAF", origin: "local", type: "بنطال", cut: "سكيني", season: "صيف 2026", costPrice: 20, sellPrice: 40, sizes: ["28", "30", "32", "34"], notes: "" },
  { modelNumber: "NOVA-001", name: "قميص كلاسيك", brand: "NOVA", origin: "foreign", type: "قميص", cut: "عادي", season: "خريف 2026", costPrice: 15, sellPrice: 35, sizes: ["S", "M", "L", "XL"], notes: "قطن 100%" },
  { modelNumber: "NOVA-002", name: "جاكيت جلد صناعي", brand: "NOVA", origin: "foreign", type: "جاكيت", cut: "قصير", season: "شتاء 2026", costPrice: 40, sellPrice: 90, sizes: ["M", "L", "XL"], notes: "" },
  { modelNumber: "ZEN-001", name: "فستان سهرة", brand: "ZEN", origin: "foreign", type: "فستان", cut: "ماكسي", season: "صيف 2026", costPrice: 28, sellPrice: 65, sizes: ["S", "M", "L"], notes: "لون أسود" },
  { name: "تنورة ميدي", brand: "MAYA", origin: "local", type: "تنورة", cut: "ميدي", season: "ربيع 2026", costPrice: 12, sellPrice: 30, sizes: ["S", "M", "L"], notes: "رقم الموديل يُولَّد تلقائياً" },
  { modelNumber: "ELT-001", name: "بلوزة أنيقة", brand: "ELT", origin: "foreign", type: "بلوزة", cut: "واسع", season: "ربيع 2026", costPrice: 30, sellPrice: 70, sizes: ["XS", "S", "M", "L", "XL", "XXL"], notes: "كل المقاسات القياسية" },
];

async function wipe(models) {
  const names = ["productModel", "series", "movement", "invoice", "return", "shipment", "counter", "supplier", "supplierInvoice", "supplierEntry", "supplierReturn", "supplierAllocation", "supplierSettlement", "cashMovement", "expense", "employee", "payrollPeriod", "employeeAdvance", "employeeLedger"];
  if (!KEEP) names.push("setting", "session");
  await Promise.all(names.map((m) => models[m].deleteMany({})));
  if (!KEEP) await models.user.deleteMany({});
}

async function main() {
  const argv = process.argv.slice(2);
  preflight({ uri: env.mongoUri, argv }); // قبل أي اتصال
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await assertDisposable({ mongoose, argv, uri: env.mongoUri });
  const dbName = mongoose.connection.name;

  const M = Object.fromEntries(
    ["productModel", "series", "movement", "invoice", "return", "shipment", "counter", "setting", "session", "user", "supplier", "supplierInvoice", "supplierEntry", "supplierReturn", "supplierAllocation", "supplierSettlement", "cashMovement", "expense", "employee", "payrollPeriod", "employeeAdvance", "employeeLedger"].map((n) => [n, require(`../src/models/${n}.model`)])
  );
  await Promise.all(Object.values(M).map((m) => m.init?.()));

  if ((await M.productModel.countDocuments()) > 0 || (await M.invoice.countDocuments()) > 0) {
    if (!ARGS.has("--reset")) throw new Error("القاعدة تحوي بيانات. استعمل reset-dev أولاً أو أضف --reset لإعادة البناء.");
  }
  await wipe(M);

  const settingService = require("../src/services/setting.service");
  const modelService = require("../src/services/productModel.service");
  const stock = require("../src/services/stock.service");
  const invoices = require("../src/services/invoice.service");
  const returns = require("../src/services/return.service");
  const userService = require("../src/services/user.service");
  const authService = require("../src/services/auth.service");
  let kseq = 0;
  const key = () => `seed-key-${String(++kseq).padStart(4, "0")}`; // حتمية: إعادة التشغيل تعطي المفاتيح نفسها

  // ---------------------------------------------------------------- الإعدادات
  // مع --keep-users يبقى سعر الصرف الحالي إن وُجد (الإعدادات من بيانات المالك)
  const existingRate = KEEP ? await M.setting.findOne().lean() : null;
  if (!(existingRate?.usdToSyp > 0)) await settingService.update({ usdToSyp: 14000 });

  // ---------------------------------------------------------------- الموديلات (+ أرتال افتتاحية لموديلين)
  const created = {};
  let b = 1;
  for (const m of MODELS) {
    const sizes = m.sizes.map((size, i) => ({ size, barcode: barcode(b, i + 1) }));
    const opening = m.modelNumber === "FAF-002"
      ? [{ location: "warehouse", sizes: m.sizes.map((size) => ({ size, qty: 2 })) }]
      : m.modelNumber === "ZEN-001"
        ? [{ location: "shop", sizes: m.sizes.map((size) => ({ size, qty: 1 })) }]
        : undefined;
    const doc = await modelService.createModel({ ...m, sizes, ...(opening ? { openingSeries: opening } : {}) });
    created[m.name] = doc.modelNumber;
    m.modelNumber = doc.modelNumber;
    b++;
  }
  console.log("الموديلات:", MODELS.map((m) => m.modelNumber).join(", "));

  // ---------------------------------------------------------------- شحنات: مستودع (رتلان) + مستودع (رتل جزئي) + محل
  for (const m of MODELS) {
    const all = (q) => Object.fromEntries(m.sizes.map((s) => [s, q]));
    const some = Object.fromEntries(m.sizes.filter((_, i) => i % 2 === 0).map((s) => [s, 1]));
    await stock.receiveShipment({ modelNumber: m.modelNumber, location: "warehouse", idempotencyKey: key(), series: [series(all(2)), series(all(1))], unitCostUsd: m.costPrice, note: `شحنة مصنع ${m.brand} الأولى` });
    await stock.receiveShipment({ modelNumber: m.modelNumber, location: "warehouse", idempotencyKey: key(), series: [series(some)], unitCostUsd: m.modelNumber === "NOVA-001" ? 17 : m.costPrice, note: "تكملة مقاسات" });
    await stock.receiveShipment({ modelNumber: m.modelNumber, location: "shop", idempotencyKey: key(), series: [series(all(2))], unitCostUsd: m.costPrice, note: "عرض المحل" });
  }

  // ---------------------------------------------------------------- نقل (جزئي → أرتال derived)، تالف، جرد
  await stock.transfer({ modelNumber: "FAF-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }, { size: "L", qty: 2 }], note: "تعبئة الرف" });
  await stock.transfer({ modelNumber: "NOVA-001", from: "warehouse", to: "shop", items: [{ size: "S", qty: 1 }] });
  await stock.transfer({ modelNumber: "ZEN-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }] });
  await stock.damage({ modelNumber: "FAF-001", size: "L", qty: 1, location: "shop", reason: "تمزق عند الخياطة" });
  await stock.damage({ modelNumber: "NOVA-001", size: "M", qty: 1, location: "warehouse", reason: "بقعة حبر" });
  await stock.damage({ modelNumber: "ZEN-001", size: "S", qty: 1, location: "shop", reason: "تلف أثناء النقل" });
  await stock.adjust({ modelNumber: "FAF-002", size: "30", location: "warehouse", newQty: 6, reason: "جرد نهاية الأسبوع (زيادة)" });
  await stock.adjust({ modelNumber: "NOVA-002", size: "L", location: "warehouse", newQty: 1, reason: "جرد: نقص" });
  await stock.adjust({ modelNumber: MODELS[5].modelNumber, size: "S", location: "shop", newQty: 1, reason: "جرد: نقص" });

  // ---------------------------------------------------------------- مبيعات
  const ids = {};
  for (const m of MODELS) {
    const doc = await M.productModel.findOne({ modelNumber: m.modelNumber }).lean();
    ids[m.modelNumber] = { id: String(doc._id), sizes: Object.fromEntries(doc.sizes.map((s) => [s.size, String(s._id)])) };
  }
  const line = (mn, size, qty, unitPrice) => ({ modelId: ids[mn].id, sizeId: ids[mn].sizes[size], qty, unitPrice });
  const MAYA = MODELS[5].modelNumber;

  const sale = async (items, currency = "USD", note = "") => invoices.createInvoice({ items, currency, note });
  const inv = [];
  inv.push(await sale([line("FAF-001", "M", 1, 45), line("NOVA-001", "L", 2, 35)]));                 // 1 عادية
  inv.push(await sale([line("ZEN-001", "M", 1, 50)], "USD", "خصم زبونة دائمة"));                      // 2 أقل من سعر البيع
  inv.push(await sale([line("FAF-002", "32", 1, 560000), line(MAYA, "M", 1, 420000)], "SYP"));       // 3 ليرة
  inv.push(await sale([line("NOVA-002", "L", 1, 30)], "USD", "تصفية: أقل من الجملة"));                // 4 أقل من الجملة
  inv.push(await sale([line("FAF-001", "S", 1, 45)]));                                                // 5 ستُلغى
  inv.push(await sale([line("NOVA-001", "M", 1, 490000)], "SYP"));                                    // 6 ليرة → مرتجع بفرق صرف
  inv.push(await sale([line("ZEN-001", "L", 1, 65)]));                                                // 7 ستُبدَّل
  inv.push(await sale([line("FAF-001", "L", 1, 45)]));                                                // 8 مرتجع تالف

  inv.push(await sale([line("ELT-001", "XXL", 1, 70), line("ELT-001", "XS", 1, 70)]));                  // 9 دولار
  inv.push(await sale([line("ELT-001", "M", 1, 1050000)], "SYP"));                                    // 10 ليرة: ستُلغى
  inv.push(await sale([line("ELT-001", "L", 2, 1000000)], "SYP"));                                    // 11 ليرة: ترجع قطعة نقداً بالليرة
  inv.push(await sale([line("NOVA-001", "XL", 1, 500000)], "SYP"));                                   // 12 ليرة: تُبدَّل بالليرة
  inv.push(await sale([line("ELT-001", "S", 1, 70)]));                                                // 13 قديمة (الفترة السابقة)
  inv.push(await sale([line("FAF-001", "XL", 1, 600000)], "SYP"));                                    // 14 قديمة بالليرة (الفترة السابقة)

  await invoices.cancelInvoice(String(inv[4]._id));
  await invoices.cancelInvoice(String(inv[9]._id));                                                   // إلغاء فاتورة بالليرة: يُعكس قبضها من صندوق الليرة

  // ---------------------------------------------------------------- مرتجعات: نقدي سليم، فرق صرف، تالف، تبديل
  await returns.createReturn({ invoiceId: String(inv[0]._id), items: [{ itemIndex: 0, qty: 1, condition: "good" }], reason: "مقاس غير مناسب", mode: "cash" });
  await settingService.update({ usdToSyp: 15000 });                                                   // تغيّر الصرف قبل مرتجع الليرة
  await returns.createReturn({ invoiceId: String(inv[5]._id), items: [{ itemIndex: 0, qty: 1, condition: "good" }], reason: "لون مختلف", mode: "cash" });
  await returns.createReturn({ invoiceId: String(inv[7]._id), items: [{ itemIndex: 0, qty: 1, condition: "damaged" }], reason: "عيب في الخياطة", mode: "cash" });
  await returns.createReturn({
    invoiceId: String(inv[6]._id), items: [{ itemIndex: 0, qty: 1, condition: "good" }], reason: "تبديل بقطعة أخرى", mode: "exchange",
    newInvoice: { items: [line("NOVA-001", "S", 1, 35)], currency: "USD" },
  });

  await returns.createReturn({ invoiceId: String(inv[10]._id), items: [{ itemIndex: 0, qty: 1, condition: "good" }], reason: "مقاس كبير", mode: "cash" });   // رد نقدي بالليرة
  await returns.createReturn({
    invoiceId: String(inv[11]._id), items: [{ itemIndex: 0, qty: 1, condition: "good" }], reason: "تبديل بمقاس أصغر", mode: "exchange",
    newInvoice: { items: [line("NOVA-001", "M", 1, 520000)], currency: "SYP" },                       // تبديل بنفس العملة: الفرق وحده نقداً
  });

  // أرشفة موديل لعرض الحالة (الفواتير والسجل محفوظة)
  await modelService.setActive(MAYA, false);
  await modelService.setActive(MAYA, true);

  // ---------------------------------------------------------------- الحسابات: مالك واحد + 3 موظفين (صلاحيات مختلفة) وجلسات
  if (!KEEP) {
    const { hashPassword } = require("../src/utils/password");
    await M.user.create({ name: ADMIN.name, username: ADMIN.username, passwordHash: await hashPassword(ADMIN.password), role: "admin", active: true });
    for (const u of STAFF) await userService.create(u);
    for (const u of await M.user.find({ username: { $in: ["admin", "sara", "omar"] } }).lean()) {
      await authService.issueSession(u, { ip: "127.0.0.1", userAgent: "seed" });
    }
  } else {
    console.log("--keep-users: الحسابات وكلمات المرور والجلسات والإعدادات لم تُمَسّ.");
  }

  // ---------------------------------------------------------------- التجار: فواتير ودفعات وسلف وبضاعة أمانة مسعّرة وتسوية وإرجاع
  const supplierService = require("../src/services/supplier.service");
  const ledger = require("../src/services/supplierLedger.service");
  const supplierReturns = require("../src/services/supplierReturn.service");
  const settlements = require("../src/services/supplierSettlement.service");
  const owner = await M.user.findOne(KEEP ? { role: "admin", active: true } : { username: ADMIN.username }).lean();
  if (!owner) throw new Error("لا يوجد حساب مالك فعّال في قاعدة البيانات.");
  const actor = { id: String(owner._id), name: owner.name };
  const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();
  const money = (amount, currency = "USD", rate) => ({ amount, currency, ...(rate ? { rate } : {}) });

  // 1) مؤسسة النور: شراء 1500$ ودُفع 1000$ مرتبطة بالفاتورة (مستحق إجمالي 500$)
  const s1 = await supplierService.create({ name: "مؤسسة النور للألبسة", phone: "0944 111 222", address: "حلب - الجميلية", notes: "مورد الجينز المحلي" });
  const fafSeries = (await M.series.find({ modelNumber: "FAF-001", kind: "received" }).sort({ seriesNo: 1 }).limit(2).lean()).map((x) => x.seriesNo);
  const i1 = await ledger.createInvoice(s1.id, { invoiceNo: "NR-2026-014", invoiceDate: daysAgo(14), dueDate: new Date(Date.now() + 16 * day).toISOString(), ...money(1500), terms: "30 يوماً", note: "شحنة جينز صيفي", seriesNos: fafSeries, idempotencyKey: key() }, actor);
  await ledger.recordPayment(s1.id, { ...money(1000), invoiceId: i1.invoice.id, date: daysAgo(7), note: "دفعة أولى", idempotencyKey: key() }, actor);

  // 2) شركة الأناقة: فاتورة بالليرة (9,000,000 ل.س) مسددة بالكامل بالليرة (حساب الليرة مستقل عن الدولار)
  const s2 = await supplierService.create({ name: "شركة الأناقة التجارية", phone: "0933 555 777", address: "دمشق - الحريقة", notes: "استيراد قمصان وجاكيتات" });
  const i2 = await ledger.createInvoice(s2.id, { invoiceNo: "ANQ-778", invoiceDate: daysAgo(20), dueDate: daysAgo(5), ...money(9000000, "SYP"), terms: "دفعة واحدة", idempotencyKey: key() }, actor);
  await ledger.recordPayment(s2.id, { ...money(9000000, "SYP"), invoiceId: i2.invoice.id, date: daysAgo(6), note: "تسديد كامل من صندوق الليرة", idempotencyKey: key() }, actor);

  // 3) أبو سامر: سلفة 300$ غير مخصّصة + بضاعة أمانة مسعّرة. بيع للزبائن قطعتان، تُسوّى منهما قطعة واحدة بسعر الاتفاق (مستحق 55$ مع بقاء السلفة: حالة mixed).
  const s3 = await supplierService.create({ name: "تاجر الجملة أبو سامر", phone: "0988 321 654", address: "حمص", notes: "يورّد بضاعة برسم الأمانة" });
  await ledger.recordAdvance(s3.id, { ...money(300), date: daysAgo(10), note: "سلفة لحجز الموديلات", idempotencyKey: key() }, actor);
  const smr = await modelService.createModel({ modelNumber: "SMR-001", name: "جاكيت كاجوال (أمانة)", brand: "SMR", origin: "local", type: "جاكيت", cut: "عادي", season: "خريف 2026", costPrice: 40, sellPrice: 95, sizes: ["M", "L"].map((size, i) => ({ size, barcode: barcode(9, i + 1) })), notes: "بضاعة أمانة من أبو سامر" });
  const smrRcv = await stock.receiveShipment({ modelNumber: "SMR-001", location: "shop", idempotencyKey: key(), series: [series({ M: 2, L: 2 })], supplierId: s3.id, consignment: true, consignmentPrice: { amount: 55, currency: "USD" }, note: "أمانة بسعر اتفاق 55$ للقطعة" });
  const maya = await stock.receiveShipment({ modelNumber: MAYA, location: "warehouse", idempotencyKey: key(), series: [series({ S: 2, M: 2 })], supplierId: s3.id, consignment: true, consignmentPrice: { amount: 300000, currency: "SYP" }, note: "أمانة بسعر اتفاق 300,000 ل.س" });
  const smrDoc = await M.productModel.findOne({ modelNumber: "SMR-001" }).lean();
  await invoices.createInvoice({ items: [{ modelId: String(smrDoc._id), sizeId: String(smrDoc.sizes.find((x) => x.size === "M")._id), qty: 2, unitPrice: 95 }], currency: "USD", note: "بيع جاكيت أمانة" });
  await settlements.post(s3.id, { items: [{ seriesId: smrRcv.series[0].id, size: "M", qty: 1 }], note: "تسوية أولى: قطعة واحدة من الاثنتين المباعتين", idempotencyKey: key() }, actor);
  await supplierReturns.createReturn(s3.id, { items: [{ seriesId: maya.series[0].id, size: "S", qty: 2 }, { seriesId: maya.series[0].id, size: "M", qty: 2 }], reason: "الموديل لا يُباع: إرجاع للتاجر", idempotencyKey: key() }, actor);

  // 4) تاجر قديم معطّل (يعرض فلتر التعطيل؛ لا حذف للتجار)
  const s4 = await supplierService.create({ name: "مستودع الشرق (متوقف)", phone: "0955 000 111", address: "اللاذقية" });
  await supplierService.update(s4.id, { active: false });

  // 5) مصنع الشام: مستحق بالليرة (فاتورة 6,000,000 دُفع منها 2,000,000 من صندوق الليرة) + أمانة مسعّرة بالليرة تُباع وتُسوّى جزئياً
  const s5 = await supplierService.create({ name: "مصنع الشام للخياطة", phone: "0966 200 300", address: "ريف دمشق", notes: "شراء وأمانة بالليرة" });
  const i5 = await ledger.createInvoice(s5.id, { invoiceNo: "SHM-1204", invoiceDate: daysAgo(12), dueDate: new Date(Date.now() + 18 * day).toISOString(), ...money(6000000, "SYP"), terms: "60 يوماً", idempotencyKey: key() }, actor);
  await ledger.recordPayment(s5.id, { ...money(2000000, "SYP"), invoiceId: i5.invoice.id, date: daysAgo(5), note: "دفعة أولى بالليرة", idempotencyKey: key() }, actor);
  await modelService.createModel({ modelNumber: "JNS-001", name: "بلوزة صيفية (أمانة)", brand: "JNS", origin: "local", type: "بلوزة", cut: "واسع", season: "صيف 2026", costPrice: 9, sellPrice: 20, sizes: ["S", "M", "L"].map((size, i) => ({ size, barcode: barcode(10, i + 1) })), notes: "بضاعة أمانة من مصنع الشام (سعر الاتفاق بالليرة)" });
  const jns = await stock.receiveShipment({ modelNumber: "JNS-001", location: "warehouse", idempotencyKey: key(), series: [series({ S: 2, M: 2, L: 2 }), series({ S: 1, M: 1 })], supplierId: s5.id, consignment: true, consignmentPrice: { amount: 120000, currency: "SYP" }, note: "أمانة بسعر اتفاق 120,000 ل.س للقطعة" });
  await stock.transfer({ modelNumber: "JNS-001", from: "warehouse", to: "shop", items: [{ size: "S", qty: 2 }, { size: "M", qty: 2 }], note: "عرض أمانة في المحل" });
  const jnsDoc = await M.productModel.findOne({ modelNumber: "JNS-001" }).lean();
  const jline = (size, qty, unitPrice) => ({ modelId: String(jnsDoc._id), sizeId: String(jnsDoc.sizes.find((x) => x.size === size)._id), qty, unitPrice });
  await invoices.createInvoice({ items: [jline("S", 2, 180000), jline("M", 1, 180000)], currency: "SYP", note: "بيع بلوزات أمانة بالليرة" });
  const elig = (await settlements.eligible(s5.id)).items;
  const rowS = elig.find((r) => r.size === "S"), rowM = elig.find((r) => r.size === "M");
  await settlements.post(s5.id, { items: [{ seriesId: rowS.seriesId, size: "S", qty: 2 }], note: "تسوية مقاس S المباع بسعر الاتفاق", idempotencyKey: key() }, actor);
  const early = await settlements.post(s5.id, { items: [{ seriesId: rowM.seriesId, size: "M", qty: 1 }], note: "تسوية مبكرة", idempotencyKey: key() }, actor);
  await settlements.reverse(s5.id, early.settlement.id, { reason: "التاجر لم يؤكد الكمية بعد: تُعاد التسوية لاحقاً" }, actor);
  const shopSeries = await M.series.findOne({ modelNumber: "JNS-001", location: "shop" }).lean();
  await supplierReturns.createReturn(s5.id, { items: [{ seriesId: jns.series[0].id, size: "L", qty: 2 }, { seriesId: String(shopSeries._id), size: "M", qty: 1 }], reason: "إرجاع غير المباع من المستودع والمحل", idempotencyKey: key() }, actor);

  // 6) شركة الفرات: سلفة بالليرة فقط (3,000,000) + سلفة خاطئة مُعكوسة (يعود نقدها لصندوق الليرة)
  const s6 = await supplierService.create({ name: "شركة الفرات للأقمشة", phone: "0944 700 800", address: "دير الزور", notes: "حجز مسبق بالليرة" });
  await ledger.recordAdvance(s6.id, { ...money(3000000, "SYP"), date: daysAgo(9), note: "سلفة حجز أقمشة", idempotencyKey: key() }, actor);
  const wrong = await ledger.recordAdvance(s6.id, { ...money(500000, "SYP"), date: daysAgo(8), note: "سلفة مُدخلة بالخطأ", idempotencyKey: key() }, actor);
  await ledger.reverseEntry(s6.id, wrong.entry.id, { reason: "إدخال خاطئ" }, actor);

  // 7) مستورد الخليج: سلفة بالدولار (200$) خُصِّص منها 120$ على فاتورته (التخصيص لا ينشئ حركة نقد) فبقيت سلفة 80$
  const s7 = await supplierService.create({ name: "مستورد الخليج للأزياء", phone: "0933 900 100", address: "طرطوس", notes: "تعامل بالدولار" });
  const adv7 = await ledger.recordAdvance(s7.id, { ...money(200), date: daysAgo(11), note: "سلفة بالدولار", idempotencyKey: key() }, actor);
  const i7 = await ledger.createInvoice(s7.id, { invoiceNo: "GLF-90", invoiceDate: daysAgo(4), ...money(120), idempotencyKey: key() }, actor);
  await ledger.allocate(s7.id, { entryId: adv7.entry.id, invoiceId: i7.invoice.id, amount: 120, note: "تخصيص السلفة على الفاتورة", idempotencyKey: key() }, actor);

  // 8) شركة الأمل: فاتورة بالدولار (400$) سُدِّدت بالليرة بتأكيد صريح وسعر صرف مُدخَل: يخرج النقد من صندوق الليرة فقط
  const s8 = await supplierService.create({ name: "شركة الأمل للتجارة", phone: "0955 400 500", address: "اللاذقية", notes: "دفع بعملة مختلفة بتأكيد صريح" });
  const i8 = await ledger.createInvoice(s8.id, { invoiceNo: "AML-31", invoiceDate: daysAgo(6), ...money(400), idempotencyKey: key() }, actor);
  await ledger.recordPayment(s8.id, { ...money(6000000, "SYP"), invoiceId: i8.invoice.id, crossCurrency: { settlesAmount: 400, rate: 15000 }, date: daysAgo(3), note: "دفع بالليرة بسعر صرف مُدخَل صراحةً (15000)", idempotencyKey: key() }, actor);

  // ---------------------------------------------------------------- الصندوقان (ليرة/دولار): رصيد افتتاحي ومصروفات.
  // المبيعات والمرتجعات والإلغاء ودفعات الموردين سجّلت حركات نقدها تلقائياً عبر الخدمات؛ الأرصدة الافتتاحية يدخلها المالك صراحةً.
  const cashService = require("../src/services/cash.service");
  await cashService.manual({ currency: "USD", direction: "in", amount: 8000, note: "رصيد افتتاحي - صندوق الدولار", date: daysAgo(40), idempotencyKey: key() }, actor);
  await cashService.manual({ currency: "SYP", direction: "in", amount: 40000000, note: "رصيد افتتاحي - صندوق الليرة", date: daysAgo(40), idempotencyKey: key() }, actor);
  const exp = (currency, amount, category, description, d) => cashService.createExpense({ currency, amount, category, description, date: daysAgo(d), idempotencyKey: key() }, actor);
  await exp("SYP", 3500000, "إيجار", "إيجار المحل", 12);
  await exp("SYP", 450000, "كهرباء وماء", "فاتورة كهرباء المحل", 9);
  await exp("SYP", 150000, "مواصلات", "نقل بضاعة", 6);
  await exp("USD", 35, "تغليف", "أكياس وعلب", 8);
  await exp("USD", 22, "مواصلات", "شحن عينات", 4);
  const wrongExp = await exp("SYP", 99000, "أخرى", "مصروف أُدخل بالخطأ", 3);
  await cashService.reverseExpense(wrongExp.expense.id, { reason: "إدخال خاطئ" }, actor);

  // ---------------------------------------------------------------- توزيع التواريخ على آخر أسبوع (تقارير الأيام تصير مفيدة)
  const back = async (ref, days) => {
    const at = new Date(Date.now() - days * day);
    await M.movement.collection.updateMany({ ref }, { $set: { createdAt: at, updatedAt: at } });
  };
  const invDays = [7, 6, 5, 4, 3, 3, 2, 1, 5, 4, 2, 2, 33, 28];
  for (let i = 0; i < inv.length; i++) {
    const at = new Date(Date.now() - invDays[i] * day);
    await M.invoice.collection.updateOne({ _id: inv[i]._id }, { $set: { createdAt: at, updatedAt: at, ...([4, 9].includes(i) ? { cancelledAt: at } : {}) } });
    await back(`INV-${inv[i].number}`, invDays[i]);
  }
  const rets = await M.return.find().sort({ number: 1 }).lean();
  const retDays = [6, 1, 1, 0, 2, 1];
  for (let i = 0; i < rets.length; i++) {
    const at = new Date(Date.now() - (retDays[i] ?? 0) * day);
    await M.return.collection.updateOne({ _id: rets[i]._id }, { $set: { createdAt: at, updatedAt: at } });
    await back(`RET-${rets[i].number}`, retDays[i] ?? 0);
  }

  // حركات النقد تأخذ تاريخ معاملتها المصدرية (مبيعات/مرتجعات) كي تظهر في الفترة الصحيحة في لوحة المالية
  const allInv = new Map((await M.invoice.find().lean()).map((i) => [String(i._id), i]));
  const allRet = new Map((await M.return.find().lean()).map((r) => [String(r._id), r]));
  for (const mv of await M.cashMovement.find({ "source.kind": { $in: ["invoice", "return"] } }).lean()) {
    const src = (mv.source.kind === "invoice" ? allInv : allRet).get(String(mv.source.id));
    const at = mv.type === "sale_cancellation" && src?.cancelledAt ? src.cancelledAt : src?.createdAt;
    if (at) await M.cashMovement.collection.updateOne({ _id: mv._id }, { $set: { date: at, createdAt: at, updatedAt: at } });
  }

  // ---------------------------------------------------------------- الرواتب والسلف: موظفون وفترات وسلف ودفعات (عبر الخدمات الحقيقية)
  const employeeService = require("../src/services/employee.service");
  const payrollService = require("../src/services/payroll.service");
  const advanceService = require("../src/services/employeeAdvance.service");
  const finance = require("../src/services/employeeFinance.service");
  const ym = (offset) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 7); };
  const [prevKey, curKey, nextKey] = [ym(-1), ym(0), ym(1)];
  const emp = (b) => employeeService.create({ status: "active", payDay: 1, ...b }, actor);
  const period = async (employeeId, periodKey) => (await payrollService.createPeriod({ employeeId, periodKey, idempotencyKey: key() }, actor)).period;
  const adjust = (id, kind, amount, note) => payrollService.addAdjustment(id, { kind, amount, note, idempotencyKey: key() }, actor);
  // الرواتب تُدفع كمصروفات (فئة «رواتب») عبر خدمة الموظف المالية نفسها التي تستعملها المالية ← المصروفات
  const paySalary = (e, amount, periodKey, date) => finance.paySalaryExpense({ currency: e.currency, amount, category: finance.SALARY, employeeId: e.id, periodKey, date, idempotencyKey: key() }, actor);
  // السلفة تُسجَّل وتُصرف في خطوة واحدة (كما من حساب الموظف)؛ pendingOnly لعرض حالة «غير مصروفة»
  const issueAdvance = (e, amount, deductionPeriodKey, note) => finance.issueAdvance({ employeeId: e.id, amount, deductionPeriodKey, note, date: daysAgo(12), idempotencyKey: key() }, actor);

  // 1) ليلى منصور (دولار): الشهر الماضي مدفوع ومغلق وفيه سلفة سُوّيت تلقائياً؛ الشهر الحالي دُفع جزء منه؛ سلفة قائمة مسنَدة للشهر القادم
  const e1 = await emp({ name: "ليلى منصور", jobTitle: "مسؤولة المبيعات", phone: "0944 100 200", salary: 600, currency: "USD", hireDate: daysAgo(400), salaryEffectiveFrom: prevKey, notes: "موظفة منذ سنة" });
  const e1p0 = await period(e1.id, prevKey);
  await adjust(e1p0.id, "bonus", 40, "مكافأة مبيعات");
  await issueAdvance(e1, 100, prevKey, "سلفة طارئة");
  await paySalary(e1, 540, prevKey, daysAgo(18));
  await finance.closePeriod(e1.id, { periodKey: prevKey }, actor);
  await adjust((await period(e1.id, curKey)).id, "allowance", 30, "بدل مواصلات");
  await paySalary(e1, 300, curKey, daysAgo(3));
  await issueAdvance(e1, 150, nextKey, "سلفة تُخصم من الشهر القادم");

  // 2) خالد عيسى (دولار): الشهر الحالي لم يُدفع بعد (بدل واستقطاع) مع سلفة غير مصروفة بعد
  const e2 = await emp({ name: "خالد عيسى", jobTitle: "أمين المستودع", phone: "0955 300 400", salary: 450, currency: "USD", payDay: 5, hireDate: daysAgo(200) });
  const e2p1 = await period(e2.id, curKey);
  await adjust(e2p1.id, "allowance", 25, "بدل عمل إضافي");
  await adjust(e2p1.id, "deduction", 10, "غياب يوم");
  await advanceService.create({ employeeId: e2.id, amount: 80, deductionPeriodId: e2p1.id, note: "سلفة بانتظار الصرف", date: daysAgo(2), idempotencyKey: key() }, actor);

  // 3) هدى الحلبي (ليرة): الشهر الماضي مدفوع بالكامل؛ الشهر الحالي معتمد ولم يُدفع (متأخر) مع سلفة بالليرة مصروفة تُخصم عند الدفع
  const e3 = await emp({ name: "هدى الحلبي", jobTitle: "كاشيرة", phone: "0933 500 600", salary: 6500000, currency: "SYP", hireDate: daysAgo(120), salaryEffectiveFrom: prevKey });
  await period(e3.id, prevKey);
  await paySalary(e3, 6500000, prevKey, daysAgo(20));
  const e3p1 = await period(e3.id, curKey);
  await adjust(e3p1.id, "bonus", 500000, "مكافأة موسم");
  await payrollService.approve(e3p1.id, actor);
  await issueAdvance(e3, 1500000, curKey, "سلفة بالليرة");

  // 4) سامر النجار: موظف منتهي الخدمة بلا فترات (يظهر في الفلاتر)
  await emp({ name: "سامر النجار", jobTitle: "عامل تغليف", salary: 300, currency: "USD", status: "terminated", hireDate: daysAgo(700) });

  // ---------------------------------------------------------------- فحص السلامة المستقل + مطابقة الصندوقين
  const check = await verifyIntegrity(mongoose.connection.db);
  if (!check.ok) throw new Error("فشل فحص السلامة:\n - " + check.problems.join("\n - "));
  const cashRows = await M.cashMovement.find().lean();
  const recon = ["SYP", "USD"].map((c) => {
    const rows = cashRows.filter((m) => m.currency === c);
    const minor = (pred) => rows.filter(pred).reduce((n, m) => n + m.amountMinor, 0);
    const opening = minor((m) => m.source.kind === "manual" && m.direction === "in" && !m.reverses);
    const inflow = minor((m) => m.direction === "in" && !(m.source.kind === "manual" && !m.reverses));
    const outflow = minor((m) => m.direction === "out");
    const f = (v) => (c === "USD" ? v / 100 : v);
    return { currency: c, opening: f(opening), "inflows (non-opening)": f(inflow), outflows: f(outflow), balance: f(opening + inflow - outflow), "ledger balance": f(check.summary[c].balanceMinor), movements: rows.length };
  });
  console.log("\nمطابقة الصندوقين (كل عملة مستقلة):");
  console.table(recon);
  for (const r of recon) if (r.balance !== r["ledger balance"]) throw new Error(`عدم تطابق صندوق ${r.currency}`);

  // ---------------------------------------------------------------- ملخص
  const counts = {};
  for (const [n, m] of Object.entries(M)) counts[n] = await m.countDocuments();
  console.log("\nعدد المستندات في كل مجموعة:");
  console.table(counts);
  console.log("\nالحسابات:");
  if (KEEP) console.log("(--keep-users) الحسابات القائمة لم تتغير؛ سجّل الدخول بكلمات مرورك الحالية.");
  else console.table([ADMIN, ...STAFF].map((u, n) => ({ username: u.username, password: u.password, role: n ? "employee" : "admin" })));
}

main()
  .catch((err) => { console.error("فشل:", err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
