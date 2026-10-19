const { MODEL_NUMBER_REGEX } = require("../config/constants");

const normalizeModelNumber = (raw) => String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
const isValidModelNumber = (mn) => MODEL_NUMBER_REGEX.test(mn);

// بادئة من البراند: أول 3 أحرف/أرقام لاتينية (FAF → FAF, Zara → ZAR). براند عربي → MDL
const brandPrefix = (brand) => {
  const letters = String(brand ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return letters.slice(0, 3) || "MDL";
};

const formatModelNumber = (prefix, seq) => `${prefix}-${String(seq).padStart(3, "0")}`;

module.exports = { normalizeModelNumber, isValidModelNumber, brandPrefix, formatModelNumber };
