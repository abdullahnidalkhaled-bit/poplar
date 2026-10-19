const presenters = require("./presenters");
const { redact } = require("./redact");

/**
 * الاستجابة العامة: يضيف res.success(data, status) للمتحكمات.
 * إن حدّد المسار عارضاً (present("model")) فيُطبَّق على البيانات عند جاهزية الاستجابة.
 * ثم، لمن لا يملك costs.view (الموظف)، تُحذف الحقول المالية السرية على أي عمق قبل الإرسال.
 */
module.exports = (req, res, next) => {
  res.success = (data, status = 200) => {
    const name = res.locals.presenter;
    let body = name ? presenters[name](data) : data;
    if (!req.user?.permissions?.has("costs.view")) body = redact(body);
    return res.status(status).json(body);
  };
  next();
};
