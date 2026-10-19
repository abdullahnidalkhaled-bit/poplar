// يتحقق من body/query/params ويضع القيم المنظَّفة في req.valid (لا يعدّل req.query الذي هو للقراءة فقط في Express 5)
module.exports = (schemas) => (req, res, next) => {
  try {
    req.valid = {};
    for (const [source, schema] of Object.entries(schemas)) req.valid[source] = schema.parse(req[source] ?? {});
    next();
  } catch (err) {
    next(err);
  }
};
