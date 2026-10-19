// سجل العارضات المتاحة للمسارات: present("model") ... إلخ
const presenters = [
  require("./model.presenter"),
  require("./modelList.presenter"),
  require("./lookup.presenter"),
  require("./stockResult.presenter"),
];

module.exports = Object.fromEntries(presenters.map((p) => [p.name, p.present]));
