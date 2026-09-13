// 通用工具：金额、日期、id 生成等

// HTML 转义，用于把用户输入安全地插入 innerHTML，防止 XSS
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// 生成唯一 id
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// 分 -> 完整货币字符串，如 ¥12.34
export function fmtMoney(cents) {
  const n = (cents || 0) / 100;
  return '¥' + n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// 分 -> 无货币符号的数字字符串，如 12.34
export function fmtMoneyShort(cents) {
  const n = (cents || 0) / 100;
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// 用户输入字符串 -> 分（整数）。非法输入返回 0
export function parseAmount(str) {
  const cleaned = String(str).replace(/[^\d.]/g, '');
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  if (isNaN(n)) return 0;
  return Math.round(n * 100);
}

export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

// 'YYYY-MM-DD' -> 'YYYY-MM'
export function monthKey(dateStr) {
  return String(dateStr).slice(0, 7);
}

export function thisMonthKey() {
  return monthKey(todayStr());
}

// 'YYYY-MM' 加减月份
export function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// 最近 n 个月的 key（含本月，倒序）
export function lastNMonthKeys(n) {
  const res = [];
  let k = thisMonthKey();
  for (let i = 0; i < n; i++) {
    res.push(k);
    k = addMonths(k, -1);
  }
  return res;
}

// 某个月有多少天
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
