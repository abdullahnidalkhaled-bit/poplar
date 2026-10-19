const presenters = require("./presenters");

// يُستعمل في ملف المسار: router.get(path, validate(...), present("model"), controller)
module.exports = (name) => {
  if (!presenters[name]) throw new Error(`عارض غير معروف: ${name}`);
  return (req, res, next) => {
    res.locals.presenter = name;
    next();
  };
};
