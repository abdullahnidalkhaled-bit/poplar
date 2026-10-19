// تطبيع النصوص للبحث: مسافات، حالة الأحرف، تشكيل عربي، ألف/ياء/تاء مربوطة
const MARKS = /[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g;

const normalizeText = (s = "") =>
  String(s)
    .normalize("NFKD")
    .replace(MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (s) => normalizeText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { normalizeText, tokenize, escapeRegex };
