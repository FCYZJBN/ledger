// 应用主逻辑：视图渲染、记账、明细、统计、设置、导入导出
import * as db from './db.js';
import { ensureSeeded } from './seed.js';
import { renderCategoryPie, renderTrend } from './charts.js';
import { readBillFile, markDuplicates, suggestCategory, toTxn } from './bill.js';
import {
  uid, escapeHtml, fmtMoney, fmtMoneyShort, parseAmount,
  todayStr, toDateStr, monthKey, thisMonthKey, addMonths, lastNMonthKeys, daysInMonth,
} from './util.js';

// ---------- DOM 工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
// 颜色只允许合法 hex，防止导入数据注入非法样式
function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#94A3B8';
}

// ---------- 数据 ----------
let transactions = [];
let categories = [];
let accounts = [];
let budgetAmount = 0; // 分
let categoryBudgets = {}; // { 支出大类ID: 分 }，只按月、只针对支出大类
let merchantRules = {}; // { 商户名: 分类ID }，账单导入确认后自动学习，越用越准

// 账单导入的临时状态（不落库，刷新即弃）
let billDraft = null;   // 解析好、等待用户确认的草稿
let billError = null;   // 上一次解析失败的原因（含对账差异）
let billLoading = false;

// ---------- 状态 ----------
const state = {
  tab: 'home',
  subpage: null, // settings 下的子页：null | 'cats' | 'accts' | 'catbudgets' | 'about' | 'import'
  // 记账弹层
  editingId: null,
  sheetType: 'expense',
  sheetRefund: false, // 退款：勾上则这笔存成负数支出
  sheetCategoryId: null,
  sheetAccountId: null,
  sheetExpanded: null,
  // 明细筛选
  fType: 'all',
  fCategory: 'all',
  fAccount: 'all',
  fMonth: 'all',
  // 统计周期
  period: 'thisMonth',
};

// ---------- 分类/账户查询 ----------
function parentsOf(type) {
  let list = categories.filter((c) => !c.parentId);
  if (type) list = list.filter((c) => c.type === type);
  return list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
function childrenOf(pid) {
  return categories.filter((c) => c.parentId === pid).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
function catById(id) { return categories.find((c) => c.id === id); }
function acctById(id) { return accounts.find((a) => a.id === id); }
function catFullName(id) {
  const c = catById(id);
  if (!c) return '未分类';
  if (c.parentId) { const p = catById(c.parentId); return (p ? p.name + ' · ' : '') + c.name; }
  return c.name;
}
function rootCatId(id) { const c = catById(id); return c && c.parentId ? c.parentId : id; }
function sumType(list, type) { return list.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0); }

// 金额上限（分）：±10 亿元。个人记账不可能到这个量级，
// 但它能挡住被篡改的备份文件塞进来的天文数字把汇总撑爆。
// 负数要放行（退款），只卡绝对值。
const AMOUNT_LIMIT = 1e11;
function clampAmount(cents) {
  if (!Number.isFinite(cents)) return 0;
  return Math.max(-AMOUNT_LIMIT, Math.min(AMOUNT_LIMIT, cents));
}

// ---------- 数据加载 ----------
async function loadData() {
  const [t, c, a, budget, catBudgets, rules] = await Promise.all([
    db.txns.all(), db.categories.all(), db.accounts.all(),
    db.settings.get('monthlyBudget', 0),
    db.settings.get('categoryBudgets', {}),
    db.settings.get('merchantRules', {}),
  ]);
  transactions = t;
  categories = c;
  accounts = a;
  budgetAmount = budget;
  categoryBudgets = (catBudgets && typeof catBudgets === 'object' && !Array.isArray(catBudgets)) ? catBudgets : {};
  merchantRules = (rules && typeof rules === 'object' && !Array.isArray(rules)) ? rules : {};
  transactions.sort((x, y) => y.date.localeCompare(x.date) || (y.createdAt || 0) - (x.createdAt || 0));
}

// 本月各支出大类的已花金额（子类自动汇总到父类）
function monthSpentByRootCat(excludeId = null) {
  const tm = thisMonthKey();
  const map = new Map();
  transactions.forEach((t) => {
    if (t.type !== 'expense' || monthKey(t.date) !== tm) return;
    if (excludeId && t.id === excludeId) return;
    const rid = rootCatId(t.categoryId);
    map.set(rid, (map.get(rid) || 0) + t.amount);
  });
  return map;
}

// 已设预算的支出大类，按「超支程度」降序（有问题的排前面）
function categoryBudgetRows(spentMap) {
  return Object.entries(categoryBudgets)
    .filter(([cid, limit]) => limit > 0 && catById(cid))
    .map(([cid, limit]) => {
      const used = spentMap.get(cid) || 0;
      return { cat: catById(cid), limit, used, ratio: used / limit };
    })
    .sort((a, b) => b.ratio - a.ratio);
}

// 分类预算合计（只算仍然存在的分类）；传 map 用于保存前的预演
function allocatedTotal(map = categoryBudgets) {
  return Object.entries(map)
    .filter(([cid, v]) => v > 0 && catById(cid))
    .reduce((s, [, v]) => s + v, 0);
}

// 本月「没设分类预算」的支出大类花了多少 —— 这部分从「未分配」里出
function unbudgetedSpent() {
  let sum = 0;
  monthSpentByRootCat().forEach((v, rid) => {
    if (!(categoryBudgets[rid] > 0)) sum += v;
  });
  return sum;
}

// 未分配动态余额 = 总预算 − 已分配 − 未设预算分类的实际支出
// 恒等式：Σ分类剩余 + 未分配 = 总预算 − 本月总支出（首页三个数字始终对得上账）
function unallocatedBalance() {
  return budgetAmount - allocatedTotal() - unbudgetedSpent();
}

// ---------- 渲染入口 ----------
function render() {
  const view = $('#view');
  if (state.tab === 'home') view.innerHTML = renderHome();
  else if (state.tab === 'list') view.innerHTML = renderList();
  else if (state.tab === 'stats') {
    const d = computeStats(state.period);
    view.innerHTML = renderStatsHtml(d);
    requestAnimationFrame(() => {
      renderCategoryPie($('#pie-chart'), d.pieItems);
      renderTrend($('#trend-chart'), d.labels, d.values);
    });
  } else {
    view.innerHTML = renderSettings();
    if (state.subpage === 'catbudgets') updateCatBudgetSummary();
    // 分类下拉的 option 整批共用一份，selected 只能在插入 DOM 后回填
    if (state.subpage === 'import' && billDraft) syncBillSelects();
  }
  updateTabbar();
}

function updateTabbar() {
  $$('#tabbar .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === state.tab));
}

function switchTab(tab) {
  state.tab = tab;
  if (tab !== 'settings') state.subpage = null;
  render();
  window.scrollTo(0, 0);
}

function emptyHint(msg) { return `<div class="empty">${escapeHtml(msg)}</div>`; }

// ================= 首页 =================
function renderHome() {
  const tm = thisMonthKey();
  const monthTxns = transactions.filter((t) => monthKey(t.date) === tm);
  const expense = sumType(monthTxns, 'expense');
  const income = sumType(monthTxns, 'income');
  const balance = income - expense;
  const todayExp = sumType(transactions.filter((t) => t.date === todayStr()), 'expense');

  let budgetHtml = '';
  if (budgetAmount > 0) {
    const ratio = expense / budgetAmount;
    // 下界必须卡 0：当月退款比花销还多时 expense 为负，ratio 也是负的，
    // width 会算出个负百分比 —— 非法值，浏览器直接忽略，进度条看着像卡住了。
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    let cls = 'budget-bar-fill';
    let status;
    if (ratio >= 1) { cls += ' over'; status = `已超支 ${fmtMoney(expense - budgetAmount)}`; }
    else if (ratio >= 0.8) { cls += ' warn'; status = `剩余 ${fmtMoney(budgetAmount - expense)}`; }
    else status = `剩余 ${fmtMoney(budgetAmount - expense)}`;
    budgetHtml = `
      <div class="budget-card">
        <div class="budget-top"><span>本月预算</span><span class="budget-status">${status}</span></div>
        <div class="budget-nums"><b>${fmtMoneyShort(expense)}</b><span> / ${fmtMoneyShort(budgetAmount)}</span></div>
        <div class="budget-bar"><div class="${cls}" style="width:${pct}%"></div></div>
      </div>`;
  } else {
    budgetHtml = `<div class="budget-card budget-empty" data-action="go-settings">🎯 未设置本月预算，点此设置 →</div>`;
  }

  const recent = transactions.slice(0, 8);
  return `
  <div class="page home-page">
    ${budgetHtml}
    ${renderCategoryBudgetCard()}
    <div class="overview-card">
      <div class="ov-item"><div class="ov-label">本月支出</div><div class="ov-val">${fmtMoney(expense)}</div></div>
      <div class="ov-item"><div class="ov-label">本月收入</div><div class="ov-val ov-in">${fmtMoney(income)}</div></div>
      <div class="ov-item"><div class="ov-label">结余</div><div class="ov-val">${fmtMoney(balance)}</div></div>
      <div class="ov-item"><div class="ov-label">今日支出</div><div class="ov-val">${fmtMoney(todayExp)}</div></div>
    </div>
    <div class="recent">
      <div class="section-head"><span>最近记录</span><button class="link-btn" data-action="go-list">全部 ›</button></div>
      ${recent.length ? recent.map(txnRow).join('') : emptyHint('还没有记录，点下方 ＋ 记一笔')}
    </div>
  </div>`;
}

// 首页的「分类预算」卡：只列出已设预算的分类，一个都没设则整张卡不显示
function renderCategoryBudgetCard() {
  const rows = categoryBudgetRows(monthSpentByRootCat());
  if (!rows.length) return '';
  const body = rows.map(({ cat, limit, used, ratio }) => {
    // 同理卡下界：该分类当月退款超过花销时 used 为负，ratio 也是负的
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    let cls = 'budget-bar-fill';
    if (ratio >= 1) cls += ' over';
    else if (ratio >= 0.8) cls += ' warn';
    const over = ratio >= 1;
    const status = over ? `已超 ${fmtMoney(used - limit)}` : `剩余 ${fmtMoney(limit - used)}`;
    return `<div class="cb-row">
      <div class="cb-top">
        <span class="cb-name"><span class="cb-ico">${escapeHtml(cat.icon)}</span>${escapeHtml(cat.name)}</span>
        <span class="cb-status ${over ? 'over' : ''}">${status}</span>
      </div>
      <div class="budget-bar"><div class="${cls}" style="width:${pct}%"></div></div>
      <div class="cb-nums">${fmtMoneyShort(used)} / ${fmtMoneyShort(limit)}</div>
    </div>`;
  }).join('');
  return `<div class="budget-card cb-card">
    <div class="budget-top"><span>分类预算</span><span class="budget-status">本月</span></div>
    ${body}
    ${renderUnallocatedRow()}
  </div>`;
}

// 「未分配」行：只在设了总预算时才有意义（没有总额就无所谓分配）
function renderUnallocatedRow() {
  if (!(budgetAmount > 0)) return '';
  const allocated = allocatedTotal();
  const unalloc = unallocatedBalance();
  let label = '未分配';
  let text = fmtMoney(unalloc);
  let over = false;
  if (allocated > budgetAmount) {
    // 设置层面就超了：分类预算合计已经大于总预算
    label = '已超分配';
    text = fmtMoney(allocated - budgetAmount);
    over = true;
  } else if (unalloc < 0) {
    // 设置没超，但没设预算的分类把钱花光了
    label = '未分配';
    text = `已用完，超 ${fmtMoney(-unalloc)}`;
    over = true;
  }
  return `<div class="cb-unalloc">
    <span>${label}<span class="cb-unalloc-hint">留给未设预算的分类</span></span>
    <span class="cb-status ${over ? 'over' : ''}">${text}</span>
  </div>`;
}

function txnRow(t) {
  const c = catById(t.categoryId);
  const icon = c ? c.icon : '❓';
  const color = safeColor(c ? c.color : '#999');
  const name = catFullName(t.categoryId);
  const acct = acctById(t.accountId);
  const isExpense = t.type === 'expense';
  // 退款是负数支出。它仍然是一条支出（所以归在支出类和预算体系里），
  // 但钱是往回流，显示上加号 + 绿色 + 「退款」标签，免得看成"-¥-100.00"这种双重负号。
  const isRefund = isExpense && t.amount < 0;
  const sign = isExpense && !isRefund ? '-' : '+';
  const amountCls = isRefund ? 'amount-refund' : (isExpense ? 'amount-out' : 'amount-in');
  const tag = isRefund ? '<span class="txn-tag">退款</span>' : '';
  return `
  <div class="txn" data-action="edit-txn" data-id="${t.id}">
    <span class="txn-ico" style="background:${color}22;color:${color}">${escapeHtml(icon)}</span>
    <div class="txn-main">
      <div class="txn-name">${escapeHtml(name)}${tag}</div>
      <div class="txn-sub">${escapeHtml(acct ? acct.name : '')}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
    </div>
    <div class="txn-right">
      <div class="txn-amount ${amountCls}">${sign}${fmtMoneyShort(Math.abs(t.amount))}</div>
      <div class="txn-actions">
        <button class="icon-btn" data-action="copy-txn" data-id="${t.id}" title="复制">📋</button>
        <button class="icon-btn" data-action="delete-txn" data-id="${t.id}" title="删除">🗑</button>
      </div>
    </div>
  </div>`;
}

// ================= 明细 =================
function filterTxns() {
  return transactions.filter((t) => {
    if (state.fType !== 'all' && t.type !== state.fType) return false;
    if (state.fCategory !== 'all' && rootCatId(t.categoryId) !== state.fCategory) return false;
    if (state.fAccount !== 'all' && t.accountId !== state.fAccount) return false;
    if (state.fMonth !== 'all' && monthKey(t.date) !== state.fMonth) return false;
    return true;
  });
}

function distinctMonths() {
  return Array.from(new Set(transactions.map((t) => monthKey(t.date)))).sort().reverse();
}

function dateLabel(dateStr) {
  const today = todayStr();
  const yest = toDateStr(new Date(Date.now() - 86400000));
  if (dateStr === today) return '今天';
  if (dateStr === yest) return '昨天';
  const d = new Date(dateStr + 'T00:00:00');
  if (dateStr.slice(0, 4) === today.slice(0, 4)) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function groupByDate(list) {
  const map = new Map();
  list.forEach((t) => {
    if (!map.has(t.date)) map.set(t.date, []);
    map.get(t.date).push(t);
  });
  return Array.from(map.entries());
}

function renderList() {
  const filtered = filterTxns();
  const groups = groupByDate(filtered);
  const months = distinctMonths();
  const allParents = parentsOf(null);
  const catOptions = `
    <optgroup label="支出">${allParents.filter((c) => c.type === 'expense').map((c) => `<option value="${c.id}" ${state.fCategory === c.id ? 'selected' : ''}>${escapeHtml(c.icon + ' ' + c.name)}</option>`).join('')}</optgroup>
    <optgroup label="收入">${allParents.filter((c) => c.type === 'income').map((c) => `<option value="${c.id}" ${state.fCategory === c.id ? 'selected' : ''}>${escapeHtml(c.icon + ' ' + c.name)}</option>`).join('')}</optgroup>`;

  return `
  <div class="page list-page">
    <div class="filters">
      <div class="seg">
        <button class="seg-btn ${state.fType === 'all' ? 'is-active' : ''}" data-action="set-ftype" data-val="all">全部</button>
        <button class="seg-btn ${state.fType === 'expense' ? 'is-active' : ''}" data-action="set-ftype" data-val="expense">支出</button>
        <button class="seg-btn ${state.fType === 'income' ? 'is-active' : ''}" data-action="set-ftype" data-val="income">收入</button>
      </div>
      <div class="f-selects">
        <select class="f-select" id="f-cat"><option value="all">全部分类</option>${catOptions}</select>
        <select class="f-select" id="f-acct">
          <option value="all">全部账户</option>
          ${accounts.map((a) => `<option value="${a.id}" ${state.fAccount === a.id ? 'selected' : ''}>${escapeHtml(a.icon + ' ' + a.name)}</option>`).join('')}
        </select>
        <select class="f-select" id="f-month">
          <option value="all">全部月份</option>
          ${months.map((m) => `<option value="${m}" ${state.fMonth === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="txn-list">
      ${groups.map(([date, arr]) => {
        const de = sumType(arr, 'expense');
        return `<div class="day-group">
          <div class="day-head"><span>${dateLabel(date)}</span><span class="day-sum">${de !== 0 ? '支出 ' + fmtMoney(de) : ''}</span></div>
          ${arr.map(txnRow).join('')}
        </div>`;
      }).join('')}
      ${filtered.length ? '' : emptyHint('没有符合条件的记录')}
    </div>
  </div>`;
}

// ================= 统计 =================
const PERIOD_NAMES = { thisMonth: '本月', lastMonth: '上月', last3: '近3月', thisYear: '今年', all: '全部' };

function filterByPeriod(list, period) {
  if (period === 'thisMonth') { const k = thisMonthKey(); return list.filter((t) => monthKey(t.date) === k); }
  if (period === 'lastMonth') { const k = addMonths(thisMonthKey(), -1); return list.filter((t) => monthKey(t.date) === k); }
  if (period === 'last3') { const keys = lastNMonthKeys(3); return list.filter((t) => keys.includes(monthKey(t.date))); }
  if (period === 'thisYear') { const y = todayStr().slice(0, 4); return list.filter((t) => t.date.startsWith(y)); }
  return list;
}

function periodDays(period) {
  const now = new Date();
  if (period === 'thisMonth') return now.getDate();
  if (period === 'lastMonth') return daysInMonth(addMonths(thisMonthKey(), -1));
  if (period === 'last3') return lastNMonthKeys(3).reduce((s, k) => s + daysInMonth(k), 0);
  if (period === 'thisYear') return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  if (!transactions.length) return 0;
  const earliest = transactions.reduce((m, t) => (t.date < m ? t.date : m), todayStr());
  return Math.max(1, Math.floor((now - new Date(earliest + 'T00:00:00')) / 86400000) + 1);
}

function categoryBreakdown(list, type) {
  const map = new Map();
  list.filter((t) => t.type === type).forEach((t) => {
    const rid = rootCatId(t.categoryId);
    if (!map.has(rid)) {
      const c = catById(rid);
      map.set(rid, { name: c ? c.name : '未分类', value: 0, color: safeColor(c ? c.color : '#94A3B8') });
    }
    map.get(rid).value += t.amount;
  });
  return Array.from(map.values()).sort((a, b) => b.value - a.value);
}

function monthsForPeriod(period) {
  if (period === 'last3') return lastNMonthKeys(3).reverse();
  if (period === 'thisYear') {
    const y = todayStr().slice(0, 4);
    return Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  }
  if (!transactions.length) return [];
  const earliest = transactions.reduce((m, t) => (t.date < m ? t.date : m), todayStr()).slice(0, 7);
  const res = [];
  let k = earliest;
  while (k <= thisMonthKey()) { res.push(k); k = addMonths(k, 1); }
  return res;
}

function buildTrend(period, list) {
  if (period === 'thisMonth' || period === 'lastMonth') {
    const ym = period === 'thisMonth' ? thisMonthKey() : addMonths(thisMonthKey(), -1);
    const days = daysInMonth(ym);
    const labels = [], values = [];
    for (let i = 1; i <= days; i++) { labels.push(String(i)); values.push(0); }
    list.forEach((t) => {
      if (t.type !== 'expense' || monthKey(t.date) !== ym) return;
      values[Number(t.date.slice(8, 10)) - 1] += t.amount;
    });
    return { labels, values };
  }
  const months = monthsForPeriod(period);
  const labels = months.map((m) => Number(m.slice(5, 7)) + '月');
  const values = months.map(() => 0);
  list.forEach((t) => {
    if (t.type !== 'expense') return;
    const idx = months.indexOf(monthKey(t.date));
    if (idx >= 0) values[idx] += t.amount;
  });
  return { labels, values };
}

function computeStats(period) {
  const txs = filterByPeriod(transactions, period);
  const expense = sumType(txs, 'expense');
  const income = sumType(txs, 'income');
  const balance = income - expense;
  const days = periodDays(period);
  const avg = days ? expense / days : 0;
  const pieItems = categoryBreakdown(txs, 'expense');
  const { labels, values } = buildTrend(period, txs);
  return { txs, expense, income, balance, days, avg, pieItems, labels, values };
}

function renderStatsHtml(d) {
  return `
  <div class="page stats-page">
    <div class="period-tabs">
      ${Object.keys(PERIOD_NAMES).map((p) => `<button class="ptab ${state.period === p ? 'is-active' : ''}" data-action="set-period" data-period="${p}">${PERIOD_NAMES[p]}</button>`).join('')}
    </div>
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-label">支出</div><div class="stat-val">${fmtMoney(d.expense)}</div></div>
      <div class="stat-card"><div class="stat-label">收入</div><div class="stat-val in">${fmtMoney(d.income)}</div></div>
      <div class="stat-card"><div class="stat-label">结余</div><div class="stat-val ${d.balance >= 0 ? '' : 'neg'}">${fmtMoney(d.balance)}</div></div>
      <div class="stat-card"><div class="stat-label">日均支出</div><div class="stat-val">${fmtMoney(d.avg)}</div></div>
    </div>
    <div class="chart-card"><div class="card-title">分类占比（支出）</div><div class="chart" id="pie-chart"></div></div>
    <div class="chart-card"><div class="card-title">支出趋势</div><div class="chart" id="trend-chart"></div></div>
  </div>`;
}

// ================= 设置 =================
function renderSettings() {
  if (state.subpage === 'cats') return renderCategoryManager();
  if (state.subpage === 'accts') return renderAccountManager();
  if (state.subpage === 'catbudgets') return renderCategoryBudgetManager();
  if (state.subpage === 'about') return renderAbout();
  if (state.subpage === 'import') return renderImportPage();
  return renderSettingsHome();
}

function renderSettingsHome() {
  return `
  <div class="page settings-page">
    <div class="set-group">
      <div class="set-title">预算</div>
      <div class="set-card">
        <div class="set-row">
          <span>每月支出预算帽</span>
          <div class="set-input-wrap"><span>¥</span><input id="budget-input" type="text" inputmode="decimal" value="${budgetAmount ? fmtMoneyShort(budgetAmount) : ''}" placeholder="0.00"></div>
        </div>
        <button class="primary-btn full" data-action="set-budget">保存预算</button>
      </div>
    </div>
    <div class="set-group">
      <div class="set-title">记账</div>
      <div class="set-card">
        <button class="set-row arrow" data-action="open-import">🧾 导入账单（微信 / 支付宝） <span>›</span></button>
      </div>
    </div>
    <div class="set-group">
      <div class="set-title">管理</div>
      <div class="set-card">
        <button class="set-row arrow" data-action="manage-cats">📂 分类管理 <span>›</span></button>
        <button class="set-row arrow" data-action="manage-accts">💳 账户管理 <span>›</span></button>
        <button class="set-row arrow" data-action="manage-catbudgets">🎯 分类预算 <span>›</span></button>
      </div>
    </div>
    <div class="set-group">
      <div class="set-title">数据</div>
      <div class="set-card">
        <button class="set-row arrow" data-action="export-json">⬇️ 导出备份（JSON） <span>›</span></button>
        <button class="set-row arrow" data-action="import-json">⬆️ 导入备份（JSON） <span>›</span></button>
        <button class="set-row arrow" data-action="export-csv">📄 导出明细（CSV） <span>›</span></button>
      </div>
    </div>
    <div class="set-group">
      <div class="set-title">关于</div>
      <div class="set-card">
        <button class="set-row arrow" data-action="open-about">❓ 关于 / 使用帮助 <span>›</span></button>
      </div>
    </div>
  </div>`;
}

function renderAbout() {
  return `
  <div class="page manage-page about-page">
    <div class="page-head"><button class="link-btn" data-action="back-settings">‹ 返回</button><span class="page-title">关于 / 使用帮助</span></div>

    <div class="about-hero">
      <div class="about-logo">📒</div>
      <div class="about-name">记账本</div>
      <div class="about-slogan">本地记账 · 单式流水 · 收支清晰 · 数据私有</div>
    </div>

    <div class="set-group"><div class="set-title">这是什么</div><div class="set-card">
      <div class="about-block">一个跑在手机浏览器里的<b>本地记账 App</b>，收支都记、两级分类、预算红线、图表报表。数据只存在你的手机里，<b>不上传任何服务器</b>。</div>
    </div></div>

    <div class="set-group"><div class="set-title">快速上手</div><div class="set-card">
      <div class="about-block"><b>1.</b> 点底部 ＋，输入金额、选分类、选账户，保存即可（默认今天）。<br><b>2.</b> 首页看本月收支与预算，明细按日期回看，统计看图表。<br><b>3.</b> 设置里可自定义分类、账户，设每月总预算和分类预算。</div>
    </div></div>

    <div class="set-group"><div class="set-title">导入账单（微信 / 支付宝）</div><div class="set-card">
      <div class="about-block">把导出的账单文件丢进来，自动解析、归类，你过一遍确认就入账。<b>文件只在你手机里解析，一个字都不往外发。</b><br><br>
      <b>微信</b>：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账，选时间范围，填邮箱收文件。微信发来的是<b>加密压缩包</b>，需要先解压出里面的 <b>.xlsx</b> 再导进来（App 不解压加密包）。<br><br>
      <b>支付宝</b>：我的 → 账单 → 右上角 ⋯ → 开具交易流水证明 → 用于个人对账，选时间范围，填邮箱收文件。下载到的是 <b>.csv</b>，直接导。<br><br>
      导进来后会先<b>对账</b>：解析出的条数与收支合计必须和账单自带的汇总完全一致，对不上就拒绝导入——格式变了宁可报错，也不让错账进来。对上了才进待确认页，逐行可勾选、可改分类，底部显示「已选几条、合计多少」。<br><br>
      确认导入后结果块有「<b>撤销本次导入</b>」，整批一次退回，不用一条条删。</div>
    </div></div>

    <div class="set-group"><div class="set-title">账单导入的限制（先看这里）</div><div class="set-card">
      <div class="about-block">• <b>是批量导入，不是实时记账。</b>得你主动导出账单再导进来，App 没权限也没能力在后台读微信 / 支付宝的扣款。<br>• <b>微信那一步解压躲不掉。</b>浏览器做不了 AES 解密，得先用手机或电脑把加密压缩包解开拿到 xlsx。<br>• <b>账户是整批统一的。</b>一次导入共用一个账户（微信→微信，支付宝→支付宝），不按账单里的「零钱 / 余额宝 / 银行卡」细分成不同账户。<br>• <b>自己账户之间挪钱默认不计。</b>支付宝「账户存取」（如小荷包自动攒）、微信「零钱提现」属于把左口袋的钱放进右口袋，既不是收入也不是支出，默认不勾选。<br>• <b>退款会自动转成负数支出。</b>账单里退款是「收入」那行，导入时转成负数支出、从支出里扣掉，不会算成收入。同一次退款的原始消费行保留（那笔钱当时确实花出去了），两者相抵净额为 0。<br>• <b>归类是猜的，猜错请直接改。</b>支付宝自带交易分类，映射得比较准；微信没有分类列，靠商户名关键词猜。你改过的商户会被记住，下次导入同一家店就按你上次选的来。<br>• <b>重复导入是安全的。</b>每笔都带账单里的交易单号，同一份再导一次会全部标成「已导入」；日期金额方向都撞上你手记过的，会标「疑似重复」且默认不勾选，要不要记由你定。</div>
    </div></div>

    <div class="set-group"><div class="set-title">数据安全</div><div class="set-card">
      <div class="about-block">所有数据存在<b>本机浏览器</b>（IndexedDB），不会上传云端。请定期到「设置 → 导出备份（JSON）」保存；<b>换手机或清理浏览器数据前务必先备份</b>，再到新设备导入即可恢复。</div>
    </div></div>

    <div class="set-group"><div class="set-title">离线使用</div><div class="set-card">
      <div class="about-block">添加到主屏幕后，<b>断网也能照常记账、看报表</b>。打开时先用本地缓存立刻渲染，同时在后台悄悄拉一份新版。<br><br>
      代价是：<b>刚更新的版本要第二次打开才生效。</b>第一次打开看到的还是上一版，这是为「秒开 + 稳定离线」付的价。<br><br>
      如果发现界面还停在旧版，关掉重新打开一次即可。</div>
    </div></div>

    <div class="set-group"><div class="set-title">小技巧</div><div class="set-card">
      <div class="about-block">• 添加到主屏幕：浏览器菜单 →「添加到主屏幕」，之后像 App 一样全屏、离线使用。<br>• <b>记退款</b>：点 ＋ 记一笔，金额填正数，勾上「这是一笔退款」—— 钱会从该分类的支出里扣回去。别记成收入：那样本月支出和收入会同时虚高，分类预算也被白白吃掉。<br>• 预算只提醒不拦截：用掉 80% 进度条变黄、超支变红。<br>• 分类预算：可给餐饮、居住等单个大类单独设预算，只设你在意的几个即可；记账刚好花超时会当场提示。<br>• 总预算 = 各分类预算合计 + 未分配：两边对不上时会问你「把总预算改为分类合计」还是「保持总额、差额记为未分配」，由你决定；未设预算的分类花钱会从未分配里扣。<br>• 分类支持两级：大类下还能建子类，图标一键点选、也可自定义。</div>
    </div></div>

    <div class="set-group"><div class="set-title">版本</div><div class="set-card">
      <div class="set-row plain">记账本 v1.0 · 开源（MIT） · 数据仅存本机</div>
    </div></div>
  </div>`;
}

function renderCategoryManager() {
  let html = `<div class="page manage-page">
    <div class="page-head"><button class="link-btn" data-action="back-settings">‹ 返回</button><span class="page-title">分类管理</span></div>`;
  ['expense', 'income'].forEach((type) => {
    const parents = parentsOf(type);
    const label = type === 'expense' ? '支出分类' : '收入分类';
    html += `<div class="set-group"><div class="set-title">${label}</div><div class="set-card">`;
    parents.forEach((p) => {
      const kids = childrenOf(p.id);
      html += `<div class="cat-mgr-item">
        <div class="cat-mgr-row">
          <span class="cat-chip" style="background:${safeColor(p.color)}22;color:${safeColor(p.color)}">${escapeHtml(p.icon)}</span>
          <span class="cat-mgr-name">${escapeHtml(p.name)}</span>
          <span class="cat-mgr-count">${kids.length} 子类</span>
          <button class="icon-btn" data-action="add-child" data-parent="${p.id}" data-type="${type}">＋</button>
          <button class="icon-btn" data-action="edit-cat" data-id="${p.id}">✏️</button>
          <button class="icon-btn" data-action="del-cat" data-id="${p.id}">🗑</button>
        </div>
        ${kids.map((k) => `
          <div class="cat-mgr-child">
            <span class="cat-chip sm" style="background:${safeColor(k.color)}22;color:${safeColor(k.color)}">${escapeHtml(k.icon)}</span>
            <span class="cat-mgr-name">${escapeHtml(k.name)}</span>
            <button class="icon-btn" data-action="edit-cat" data-id="${k.id}">✏️</button>
            <button class="icon-btn" data-action="del-cat" data-id="${k.id}">🗑</button>
          </div>`).join('')}
      </div>`;
    });
    html += `<div class="cat-mgr-add"><button class="ghost-btn full" data-action="add-parent" data-type="${type}">＋ 新增${type === 'expense' ? '支出' : '收入'}大类</button></div>`;
    html += `</div></div>`;
  });
  return html + `</div>`;
}

function renderCategoryBudgetManager() {
  const parents = parentsOf('expense');
  return `
  <div class="page manage-page">
    <div class="page-head"><button class="link-btn" data-action="back-settings">‹ 返回</button><span class="page-title">分类预算</span></div>
    <div class="set-group">
      <div class="set-card">
        ${parents.map((p) => {
          const v = categoryBudgets[p.id] || 0;
          return `<div class="set-row cb-mgr-row">
            <span class="cb-name"><span class="cb-ico">${escapeHtml(p.icon)}</span>${escapeHtml(p.name)}</span>
            <div class="set-input-wrap"><span>¥</span><input class="cb-input" data-id="${p.id}" type="text" inputmode="decimal" value="${v ? fmtMoneyShort(v) : ''}" placeholder="不设"></div>
          </div>`;
        }).join('')}
      </div>
      <div class="cb-tip" id="cb-summary"></div>
    </div>
    <button class="primary-btn full" data-action="save-catbudgets">保存预算</button>
  </div>`;
}

// 设置页实时合计：保存前就看得见与总预算的差额，不用等弹窗
function updateCatBudgetSummary() {
  const box = $('#cb-summary');
  if (!box) return;
  const sum = $$('.cb-input').reduce((s, i) => s + parseAmount(i.value), 0);
  if (!budgetAmount) {
    box.innerHTML = `分类预算合计 <b>${fmtMoney(sum)}</b> · 尚未设置总预算`;
    return;
  }
  const diff = sum - budgetAmount;
  const tail = diff === 0 ? '与总预算一致'
    : diff > 0 ? `超出总预算 <b class="cb-diff-over">${fmtMoney(diff)}</b>`
    : `比总预算少 ${fmtMoney(-diff)}`;
  box.innerHTML = `分类预算合计 <b>${fmtMoney(sum)}</b> · 总预算 ${fmtMoney(budgetAmount)} · ${tail}`;
}

async function saveCategoryBudgets() {
  const next = {};
  let count = 0;
  $$('.cb-input').forEach((inp) => {
    const v = parseAmount(inp.value);
    if (v > 0) { next[inp.dataset.id] = v; count++; }
  });
  const sum = allocatedTotal(next);

  // 与总预算不一致时，让用户决定哪边适配哪边（没设总预算、或清空分类预算时不打扰）
  if (budgetAmount > 0 && count > 0 && sum !== budgetAmount) {
    const diff = sum - budgetAmount;
    const msg = `分类预算合计 ${fmtMoney(sum)}，与总预算 ${fmtMoney(budgetAmount)} `
      + (diff > 0 ? `相差 ${fmtMoney(diff)}（超出）` : `相差 ${fmtMoney(-diff)}`);
    const choice = await chooseDialog('总预算与分类预算不一致', msg, [
      { label: `把总预算改为 ${fmtMoney(sum)}`, class: 'link-btn', value: 'sync' },
      { label: '保持总额，差额记为未分配', class: 'primary-btn', value: 'keep' },
    ]);
    if (choice === null) return; // 关掉弹窗 = 放弃本次保存
    if (choice === 'sync') {
      await db.settings.set('monthlyBudget', sum);
      budgetAmount = sum;
    }
  }

  await db.settings.set('categoryBudgets', next);
  categoryBudgets = next;
  state.subpage = null;
  state.tab = 'home';
  render();
  toast(count ? `已保存 ${count} 个分类预算` : '已清空分类预算');
}

function renderAccountManager() {
  return `
  <div class="page manage-page">
    <div class="page-head"><button class="link-btn" data-action="back-settings">‹ 返回</button><span class="page-title">账户管理</span></div>
    <div class="set-group"><div class="set-card">
      ${accounts.map((a) => `
        <div class="cat-mgr-row">
          <span class="cat-chip" style="background:${safeColor(a.color)}22;color:${safeColor(a.color)}">${escapeHtml(a.icon)}</span>
          <span class="cat-mgr-name">${escapeHtml(a.name)}</span>
          <button class="icon-btn" data-action="edit-acct" data-id="${a.id}">✏️</button>
          <button class="icon-btn" data-action="del-acct" data-id="${a.id}">🗑</button>
        </div>`).join('')}
      <div class="cat-mgr-add"><button class="ghost-btn full" data-action="add-acct">＋ 新增账户</button></div>
    </div></div>
  </div>`;
}

// ================= 弹层（记一笔/编辑） =================
function openSheet(editingId = null, prefill = null) {
  state.editingId = editingId;
  if (editingId) {
    const t = transactions.find((x) => x.id === editingId);
    if (t) {
      state.sheetType = t.type;
      // 退款存的是负数支出。金额框里只放绝对值，正负由「退款」勾选框表达 ——
      // 让输入框自己去处理负号，会和 sanitizeAmount 的数字清洗打架。
      state.sheetRefund = t.type === 'expense' && t.amount < 0;
      state.sheetCategoryId = t.categoryId;
      state.sheetAccountId = t.accountId;
      state.sheetExpanded = null;
      $('#sheet-amount').value = fmtMoneyShort(Math.abs(t.amount));
      $('#sheet-date').value = t.date;
      $('#sheet-note').value = t.note || '';
    }
  } else {
    state.sheetType = prefill ? (prefill.type || 'expense') : 'expense';
    state.sheetRefund = false;
    state.sheetCategoryId = prefill ? (prefill.categoryId || null) : null;
    state.sheetAccountId = prefill ? (prefill.accountId || accounts[0]?.id || null) : (accounts[0]?.id || null);
    state.sheetExpanded = null;
    $('#sheet-amount').value = prefill && prefill.amount ? fmtMoneyShort(Math.abs(prefill.amount)) : '';
    $('#sheet-date').value = prefill && prefill.date ? prefill.date : todayStr();
    $('#sheet-note').value = prefill && prefill.note ? prefill.note : '';
  }
  renderSheet();
  $('#sheet').classList.remove('hidden');
  $('#sheet-backdrop').classList.remove('hidden');
  setTimeout(() => $('#sheet-amount').focus(), 250);
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheet-backdrop').classList.add('hidden');
}

function renderSheet() {
  $('#sheet-title').textContent = state.editingId ? '编辑记录' : '记一笔';
  $('#type-expense').classList.toggle('is-active', state.sheetType === 'expense');
  $('#type-income').classList.toggle('is-active', state.sheetType === 'income');
  // 退款只对支出现有意义 —— 收入没有「退」一说，切到收入时必须收起来，
  // 否则会留下一个勾着但不起作用的开关，比没有更让人困惑。
  const isExpense = state.sheetType === 'expense';
  if (!isExpense) state.sheetRefund = false;
  $('#refund-toggle').classList.toggle('hidden', !isExpense);
  $('#sheet-refund').checked = state.sheetRefund;
  renderCatArea();
  renderAccountChips();
}

function renderCatArea() {
  const parents = parentsOf(state.sheetType);
  $('#sheet-cats').innerHTML = parents.map((p) => {
    const kids = childrenOf(p.id);
    const isSel = state.sheetCategoryId === p.id || kids.some((k) => k.id === state.sheetCategoryId);
    const expanded = state.sheetExpanded === p.id;
    const chip = `<button class="cat-parent ${isSel ? 'is-active' : ''}" data-id="${p.id}">
      <span class="cat-ico">${escapeHtml(p.icon)}</span><span>${escapeHtml(p.name)}</span>
      ${kids.length ? `<span class="cat-expand">${expanded ? '▾' : '▸'}</span>` : ''}
    </button>`;
    const childHtml = (expanded && kids.length)
      ? `<div class="cat-children">${kids.map((k) => `<button class="cat-child ${state.sheetCategoryId === k.id ? 'is-active' : ''}" data-id="${k.id}"><span class="cat-ico">${escapeHtml(k.icon)}</span><span>${escapeHtml(k.name)}</span></button>`).join('')}</div>`
      : '';
    return `<div class="cat-group">${chip}${childHtml}</div>`;
  }).join('');
}

function renderAccountChips() {
  $('#sheet-accounts').innerHTML = accounts.map((a) => `<button class="chip ${state.sheetAccountId === a.id ? 'is-active' : ''}" data-id="${a.id}"><span class="cat-ico">${escapeHtml(a.icon)}</span><span>${escapeHtml(a.name)}</span></button>`).join('');
}

function setSheetType(type) {
  if (state.sheetType === type) return;
  state.sheetType = type;
  state.sheetCategoryId = null;
  state.sheetExpanded = null;
  renderSheet();
}

function sanitizeAmount(e) {
  const inp = e.target;
  let v = inp.value.replace(/[^\d.]/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
  if (parts[1] && parts[1].length > 2) v = parts[0] + '.' + parts[1].slice(0, 2);
  inp.value = v;
}

async function saveSheet() {
  // 金额框里永远是正数，符号在这一处由「退款」开关决定。
  const raw = parseAmount($('#sheet-amount').value);
  if (raw <= 0) { toast('请输入金额'); return; }
  // 退款 = 负数支出。不新增 type，是因为所有汇总都长成
  // `filter(type === 'expense').reduce((s, t) => s + t.amount, 0)` 的样子，
  // 金额一旦可为负，支出合计、分类预算、占比环图、趋势柱图、日均全都自动算对；
  // 若新增一个 'refund' 类型，上面每一处都得改，收益却一样。
  const amount = state.sheetRefund && state.sheetType === 'expense' ? -raw : raw;
  if (!state.sheetCategoryId) { toast('请选择分类'); return; }
  if (!state.sheetAccountId) { toast('请选择账户'); return; }
  const existing = state.editingId ? transactions.find((x) => x.id === state.editingId) : null;
  const txn = {
    id: state.editingId || uid(),
    type: state.sheetType,
    amount,
    categoryId: state.sheetCategoryId,
    accountId: state.sheetAccountId,
    date: $('#sheet-date').value || todayStr(),
    note: $('#sheet-note').value.trim(),
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  // 这个对象是逐字段重建的，编辑一条从账单导入的记录时必须把来源单号带回去。
  // 丢了 billNo 就等于把它降级成手记记录，下次导入同一份账单会重复入账。
  if (existing && existing.billNo) txn.billNo = existing.billNo;
  if (existing && existing.importBatch) txn.importBatch = existing.importBatch;
  // 保存前判断：这笔是否让某分类由「未超」变「已超」（编辑时排除这条的旧值）
  const overMsg = crossBudgetMessage(txn);
  if (state.editingId) await db.txns.update(txn);
  else await db.txns.add(txn);
  closeSheet();
  await loadData();
  render();
  toast(overMsg || '已保存');
}

// 若本次保存使该分类本月支出跨过预算红线，返回提示文案，否则 null
function crossBudgetMessage(txn) {
  if (txn.type !== 'expense') return null;
  if (monthKey(txn.date) !== thisMonthKey()) return null;
  const rootId = rootCatId(txn.categoryId);
  const limit = categoryBudgets[rootId] || 0;
  if (!(limit > 0)) return null;
  const before = monthSpentByRootCat(state.editingId).get(rootId) || 0;
  const after = before + txn.amount;
  if (before <= limit && after > limit) {
    const c = catById(rootId);
    return `${c ? c.name : '该分类'} 已超预算 ${fmtMoney(after - limit)}`;
  }
  return null;
}

async function copyTxn(id) {
  const t = transactions.find((x) => x.id === id);
  if (!t) return;
  openSheet(null, { type: t.type, amount: t.amount, categoryId: t.categoryId, accountId: t.accountId, note: t.note, date: todayStr() });
}

async function deleteTxn(id) {
  const ok = await confirmDialog('删除这条记录？');
  if (!ok) return;
  await db.txns.remove(id);
  await loadData();
  render();
  toast('已删除');
}

// ================= 弹窗 / 提示 =================
function showModal({ title, body, actions }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const foot = $('#modal-foot');
  foot.innerHTML = '';
  (actions || []).forEach((a) => {
    const b = document.createElement('button');
    b.className = a.class || 'primary-btn';
    b.textContent = a.label;
    b.addEventListener('click', () => a.onClick());
    foot.appendChild(b);
  });
  $('#modal').classList.remove('hidden');
  $('#modal-backdrop').classList.remove('hidden');
}
// 关闭弹窗时若有等待中的对话框，一律当作「取消」——否则 Promise 永远悬着，调用方静默卡死
let dialogResolve = null;
function hideModal() {
  $('#modal').classList.add('hidden');
  $('#modal-backdrop').classList.add('hidden');
  if (dialogResolve) { const done = dialogResolve; dialogResolve = null; done(null); }
}

// 通用多选项对话框：resolve 所选项的 value，点 ✕/背景关闭则 resolve null
function chooseDialog(title, message, options) {
  return new Promise((resolve) => {
    const done = (v) => { dialogResolve = null; hideModal(); resolve(v); };
    dialogResolve = done;
    showModal({
      title,
      body: `<div class="confirm-msg">${escapeHtml(message)}</div>`,
      actions: options.map((o) => ({ label: o.label, class: o.class, onClick: () => done(o.value) })),
    });
  });
}

function confirmDialog(message) {
  return chooseDialog('确认', message, [
    { label: '取消', class: 'link-btn', value: false },
    { label: '确定', class: 'danger-btn', value: true },
  ]);
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

// ================= 图标点选 =================
const EMOJI_SETS = {
  expense: [
    { label: '餐饮', icons: ['🍜', '🍚', '🍔', '🍟', '🍱', '🥡', '🍰', '☕', '🧋', '🍺'] },
    { label: '交通', icons: ['🚌', '🚇', '🚗', '🚕', '🚲', '✈️', '🚄', '⛽'] },
    { label: '购物', icons: ['🛍️', '👗', '👟', '👜', '💄', '🎁', '📱', '💻'] },
    { label: '居住', icons: ['🏠', '💡', '💧', '📦', '🧻', '🔧', '🧺'] },
    { label: '娱乐', icons: ['🎮', '🎬', '🎵', '📚', '⚽', '🎤', '🎨'] },
    { label: '医疗', icons: ['💊', '🏥', '🩺', '💉', '😷'] },
    { label: '教育', icons: ['📖', '✏️', '🎓', '📐', '💼'] },
    { label: '人情', icons: ['🧧', '❤️', '💐', '🍷', '🎁'] },
    { label: '其他', icons: ['🐱', '🏃', '📦', '🧾', '🔧'] },
  ],
  income: [
    { label: '收入', icons: ['💰', '💵', '💳', '🧧', '📈', '💼', '🏦', '🎁', '💹', '📊'] },
  ],
  account: [
    { label: '账户', icons: ['💳', '💰', '💵', '🏦', '📱', '💲', '🧧', '💎', '📊', '🪙'] },
  ],
};

let iconPickerTarget = null; // 正在选图标的输入框 id：'c-icon' | 'a-icon'

// 图标行：隐藏 input 存值，可见按钮展示预览并触发点选
function iconRowHtml(id, context, icon, placeholder) {
  const v = icon || placeholder;
  return `<div class="form-row"><label>图标</label>
    <button class="icon-preview" id="${id}-preview" data-target="${id}" data-context="${context}">
      <span class="ip-emoji">${escapeHtml(v)}</span><span class="ip-hint">点选</span>
    </button>
    <input id="${id}" type="hidden" value="${escapeHtml(v)}">
  </div>`;
}

function updateIconPreview(targetId) {
  const btn = $('#' + targetId + '-preview');
  if (!btn) return;
  btn.querySelector('.ip-emoji').textContent = $('#' + targetId).value.trim() || '📦';
}

function openIconPicker(targetId, context) {
  iconPickerTarget = targetId;
  const groups = EMOJI_SETS[context] || EMOJI_SETS.account;
  $('#icon-picker-custom').value = $('#' + targetId).value.trim();
  $('#icon-picker-grid').innerHTML = groups.map((g) => `
    <div class="ip-group">
      <div class="ip-group-label">${g.label}</div>
      <div class="ip-grid">${g.icons.map((ic) => `<button class="ip-item" data-emoji="${ic}">${ic}</button>`).join('')}</div>
    </div>`).join('');
  $('#icon-picker').classList.remove('hidden');
  $('#icon-picker-backdrop').classList.remove('hidden');
}

function closeIconPicker() {
  $('#icon-picker').classList.add('hidden');
  $('#icon-picker-backdrop').classList.add('hidden');
  iconPickerTarget = null;
}

function selectIcon(emoji) {
  if (!iconPickerTarget) return;
  $('#' + iconPickerTarget).value = emoji;
  updateIconPreview(iconPickerTarget);
  closeIconPicker();
}

function buildIconPicker() {
  const backdrop = el('<div class="icon-picker-backdrop hidden" id="icon-picker-backdrop"></div>');
  const picker = el(`
    <div class="icon-picker hidden" id="icon-picker">
      <div class="ip-head"><div class="ip-title">选择图标</div><button class="link-btn" id="icon-picker-close">✕</button></div>
      <div class="ip-custom"><input id="icon-picker-custom" type="text" placeholder="✏️ 自定义 emoji（选填）" maxlength="4"></div>
      <div class="ip-grid-wrap" id="icon-picker-grid"></div>
    </div>`);
  document.body.append(backdrop, picker);
  $('#icon-picker-backdrop').addEventListener('click', closeIconPicker);
  $('#icon-picker-close').addEventListener('click', closeIconPicker);
  $('#icon-picker-custom').addEventListener('input', (e) => {
    if (!iconPickerTarget) return;
    $('#' + iconPickerTarget).value = e.target.value.trim();
    updateIconPreview(iconPickerTarget);
  });
  $('#icon-picker-grid').addEventListener('click', (e) => {
    const it = e.target.closest('.ip-item');
    if (it) selectIcon(it.dataset.emoji);
  });
}

// ================= 分类/账户 编辑 =================
function openCategoryModal({ catId = null, type = 'expense', presetParentId = null }) {
  const cat = catId ? catById(catId) : null;
  const effType = cat ? cat.type : type;
  const parents = parentsOf(effType);
  const parentVal = cat ? (cat.parentId || '') : (presetParentId || '');
  const body = `
    <div class="form-row"><label>名称</label><input id="c-name" type="text" value="${escapeHtml(cat ? cat.name : '')}" placeholder="分类名称"></div>
    ${iconRowHtml('c-icon', effType, cat ? cat.icon : '', '📦')}
    <div class="form-row"><label>颜色</label><input id="c-color" type="color" value="${safeColor(cat ? cat.color : '#4F6EF7')}"></div>
    <div class="form-row"><label>父分类</label>
      <select id="c-parent">
        <option value="">（顶级分类）</option>
        ${parents.filter((p) => p.id !== catId).map((p) => `<option value="${p.id}" ${p.id === parentVal ? 'selected' : ''}>${escapeHtml(p.icon + ' ' + p.name)}</option>`).join('')}
      </select>
    </div>`;
  showModal({
    title: catId ? '编辑分类' : '新增分类',
    body,
    actions: [
      { label: '取消', class: 'link-btn', onClick: hideModal },
      { label: '保存', class: 'primary-btn', onClick: () => saveCategory(catId, effType) },
    ],
  });
}

async function saveCategory(catId, type) {
  const name = $('#c-name').value.trim();
  if (!name) { toast('请输入名称'); return; }
  const icon = $('#c-icon').value.trim() || '📦';
  const color = safeColor($('#c-color').value);
  const parentId = $('#c-parent').value || null;
  const existing = catId ? catById(catId) : null;
  const catType = existing ? existing.type : (parentId ? catById(parentId).type : type);
  const cat = {
    id: catId || uid(),
    name, icon, color, parentId, type: catType,
    sortOrder: existing ? existing.sortOrder : 9999,
  };
  if (catId) await db.categories.update(cat); else await db.categories.add(cat);
  hideModal();
  await loadData();
  render();
  toast('已保存');
}

async function deleteCategory(id) {
  const cat = catById(id);
  const kids = childrenOf(id);
  const ids = [id, ...kids.map((k) => k.id)];
  if (transactions.some((t) => ids.includes(t.categoryId))) { toast('该分类下有记录，无法删除'); return; }
  const ok = await confirmDialog(`删除分类「${cat.name}」${kids.length ? `及其 ${kids.length} 个子分类` : ''}？`);
  if (!ok) return;
  for (const cid of ids) await db.categories.remove(cid);
  // 顺带清掉被删分类的预算，避免留下孤儿数据
  const nextBudgets = { ...categoryBudgets };
  let budgetChanged = false;
  ids.forEach((cid) => { if (nextBudgets[cid] !== undefined) { delete nextBudgets[cid]; budgetChanged = true; } });
  if (budgetChanged) {
    await db.settings.set('categoryBudgets', nextBudgets);
    categoryBudgets = nextBudgets;
  }
  await loadData();
  render();
  toast('已删除');
}

function openAccountModal(acctId) {
  const a = acctId ? acctById(acctId) : null;
  const body = `
    <div class="form-row"><label>名称</label><input id="a-name" type="text" value="${escapeHtml(a ? a.name : '')}" placeholder="账户名称"></div>
    ${iconRowHtml('a-icon', 'account', a ? a.icon : '', '💳')}
    <div class="form-row"><label>颜色</label><input id="a-color" type="color" value="${safeColor(a ? a.color : '#4F6EF7')}"></div>`;
  showModal({
    title: acctId ? '编辑账户' : '新增账户',
    body,
    actions: [
      { label: '取消', class: 'link-btn', onClick: hideModal },
      { label: '保存', class: 'primary-btn', onClick: () => saveAccount(acctId) },
    ],
  });
}

async function saveAccount(acctId) {
  const name = $('#a-name').value.trim();
  if (!name) { toast('请输入名称'); return; }
  const existing = acctId ? acctById(acctId) : null;
  const a = {
    id: acctId || uid(),
    name,
    icon: $('#a-icon').value.trim() || '💳',
    color: safeColor($('#a-color').value),
    sortOrder: existing ? existing.sortOrder : 9999,
  };
  if (acctId) await db.accounts.update(a); else await db.accounts.add(a);
  hideModal();
  await loadData();
  render();
  toast('已保存');
}

async function deleteAccount(id) {
  const a = acctById(id);
  if (transactions.some((t) => t.accountId === id)) { toast('该账户下有记录，无法删除'); return; }
  const ok = await confirmDialog(`删除账户「${a.name}」？`);
  if (!ok) return;
  await db.accounts.remove(id);
  await loadData();
  render();
  toast('已删除');
}

// ================= 预算 =================
async function saveBudget() {
  const v = parseAmount($('#budget-input').value);
  if (v <= 0) { toast('请输入有效的预算金额'); return; }
  // 总预算低于已分配的分类预算合计 → 提醒但允许保存（沿用「只提醒不拦截」）
  // 调低总预算时刻意不提供「自动调整分类预算」：怎么重排是你的决定，去分类预算页改
  const allocated = allocatedTotal();
  if (allocated > v) {
    const msg = `总预算 ${fmtMoney(v)} 低于分类预算合计 ${fmtMoney(allocated)}，`
      + `将超分配 ${fmtMoney(allocated - v)}。仍然保存？`;
    const choice = await chooseDialog('总预算低于已分配', msg, [
      { label: '取消', class: 'link-btn', value: null },
      { label: '仍然保存', class: 'primary-btn', value: 'ok' },
    ]);
    if (choice !== 'ok') return;
  }
  await db.settings.set('monthlyBudget', v);
  budgetAmount = v;
  state.tab = 'home';
  render();
  toast('预算已保存');
}

// ================= 导出 / 导入 =================
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJSON() {
  const data = {
    app: '记账本',
    version: 1,
    exportedAt: new Date().toISOString(),
    budget: budgetAmount,
    categoryBudgets,
    merchantRules,
    categories,
    accounts,
    transactions,
  };
  download('记账备份-' + todayStr() + '.json', JSON.stringify(data, null, 2), 'application/json');
  toast('已导出 JSON 备份');
}

function exportCSV() {
  const header = ['日期', '类型', '分类', '账户', '备注', '金额'];
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const rows = sorted.map((t) => [
    t.date,
    t.type === 'expense' ? '支出' : '收入',
    catFullName(t.categoryId),
    acctById(t.accountId)?.name || '',
    t.note || '',
    (t.amount / 100).toFixed(2),
  ]);
  const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  download('记账明细-' + todayStr() + '.csv', '﻿' + csv, 'text/csv;charset=utf-8');
  toast('已导出 CSV 明细');
}

const VALID_BILL_NO = /^(wx|ali):[A-Za-z0-9_-]{1,64}$/;
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function validHex(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c); }
function asString(v, fb) { return typeof v === 'string' ? v : fb; }

// 导入前规范化：重新生成所有 id 并重映射引用，校验日期/颜色/金额等字段类型，
// 防止恶意或损坏的备份文件造成 XSS 注入或数据损坏
function sanitizeImport(raw) {
  const catIdMap = new Map();
  const acctIdMap = new Map();

  const cats = (Array.isArray(raw.categories) ? raw.categories : []).map((c) => {
    const oldId = typeof c.id === 'string' ? c.id : '';
    const newId = uid();
    catIdMap.set(oldId, newId);
    return {
      id: newId,
      name: asString(c.name, '未命名').slice(0, 50),
      type: c.type === 'income' ? 'income' : 'expense',
      parentId: null,
      _oldParentId: typeof c.parentId === 'string' ? c.parentId : null,
      icon: asString(c.icon, '📦').slice(0, 8),
      color: validHex(c.color) ? c.color : '#94A3B8',
      sortOrder: Number.isFinite(c.sortOrder) ? c.sortOrder : 9999,
    };
  });
  cats.forEach((c) => {
    c.parentId = c._oldParentId ? (catIdMap.get(c._oldParentId) || null) : null;
    delete c._oldParentId;
  });

  const accts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => {
    const oldId = typeof a.id === 'string' ? a.id : '';
    const newId = uid();
    acctIdMap.set(oldId, newId);
    return {
      id: newId,
      name: asString(a.name, '账户').slice(0, 50),
      icon: asString(a.icon, '💳').slice(0, 8),
      color: validHex(a.color) ? a.color : '#94A3B8',
      sortOrder: Number.isFinite(a.sortOrder) ? a.sortOrder : 9999,
    };
  });

  const txns = (Array.isArray(raw.transactions) ? raw.transactions : []).map((t) => {
    const out = {
      id: uid(),
      type: t.type === 'income' ? 'income' : 'expense',
      // 负数金额要原样保留：退款就存成负数支出。
      // 这里曾经是 Math.max(0, ...)，会把退款静默清零 —— 备份、换手机、恢复之后
      // 退款全变成 0 元，还不报错。这种「数据悄悄坏了」比报错难查得多。
      // 只挡住非有限值和超出合理范围的天文数字，别的不动。
      amount: Number.isFinite(t.amount) ? clampAmount(Math.round(t.amount)) : 0,
      categoryId: catIdMap.get(t.categoryId) || '',
      accountId: acctIdMap.get(t.accountId) || '',
      date: validDate(t.date) ? t.date : todayStr(),
      note: asString(t.note, '').slice(0, 200),
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
      updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : Date.now(),
    };
    // 账单来源单号：只接受严格格式（来源前缀 + 单号），它是去重的唯一依据，
    // 被污染会让下次导入漏判重复。旧备份没有这两个字段，缺省即手记记录，是正确的。
    if (VALID_BILL_NO.test(asString(t.billNo, ''))) out.billNo = t.billNo;
    if (Number.isFinite(t.importBatch) && t.importBatch > 0) out.importBatch = t.importBatch;
    return out;
  });

  const budget = Number.isFinite(raw.budget) ? Math.max(0, Math.round(raw.budget)) : null;

  // 分类预算：键是分类 id，必须跟着重映射后的新 id 走；老备份没有此字段则视为空
  const rawBudgets = (raw.categoryBudgets && typeof raw.categoryBudgets === 'object' && !Array.isArray(raw.categoryBudgets))
    ? raw.categoryBudgets : {};
  const budgets = {};
  Object.entries(rawBudgets).forEach(([oldId, v]) => {
    const newId = catIdMap.get(oldId);
    if (newId && Number.isFinite(v) && v > 0) budgets[newId] = Math.round(v);
  });

  // 归类学习规则：键是商户名（纯文本，只用于比对，不参与渲染），值是分类 id。
  // 值必须重映射到新 id，否则恢复出来的规则全部指向已不存在的分类。
  const rawRules = (raw.merchantRules && typeof raw.merchantRules === 'object' && !Array.isArray(raw.merchantRules))
    ? raw.merchantRules : {};
  const rules = {};
  Object.entries(rawRules).forEach(([merchant, oldCatId]) => {
    const newId = catIdMap.get(oldCatId);
    const key = asString(merchant, '').trim().slice(0, 80);
    if (newId && key) rules[key] = newId;
  });

  return { categories: cats, accounts: accts, transactions: txns, budget, categoryBudgets: budgets, merchantRules: rules };
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.categories)) throw new Error('文件格式不正确');
      const cleaned = sanitizeImport(data);
      const ok = await confirmDialog(`导入将覆盖当前全部数据（现有 ${transactions.length} 条记录，将替换为 ${cleaned.transactions.length} 条），确认继续？`);
      if (!ok) return;
      await db.importAll(cleaned);
      await loadData();
      render();
      toast('导入成功');
    } catch (err) {
      toast('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
}

// ================= 账单导入 =================
//
// 数据流：选文件 → readBillFile() 纯本地解析 → 与账单自带的汇总硬对账 →
// 通过才生成草稿 → 用户逐行确认 → bulkAdd 一次入库。
//
// 全程不联网、不上传（js/bill.js 里没有任何 fetch）。对账不通过一律拒绝入库：
// 宁可让用户手动补记，也不能把一份解析错位的账悄悄记进去。

const BILL_SOURCES = {
  wechat: { name: '微信支付', accountId: 'acct-wechat', icon: '💚' },
  alipay: { name: '支付宝', accountId: 'acct-alipay', icon: '💙' },
  unknown: { name: '账单', accountId: '', icon: '🧾' },
};

let billCatOptions = null; // 分类下拉的 option HTML，整批复用同一份

function defaultAccountFor(source) {
  const want = (BILL_SOURCES[source] || BILL_SOURCES.unknown).accountId;
  if (want && acctById(want)) return want;
  return accounts.length ? accounts[0].id : '';
}

// 归类结果兜底：学习规则可能指向一个已被删掉的分类
function safeCat(id, type) {
  const c = catById(id);
  if (c && c.type === type) return id;
  const ps = parentsOf(type);
  return ps.length ? ps[0].id : '';
}

// 分类下拉的全部 option，两个类型各生成一次整批复用。
// 逐行生成的话 100 行 × 40 多个分类 = 4000+ 个 option、几百 KB 的 HTML 串，
// 低端机会明显卡顿；共用一份后只有一行 HTML 解析的代价。
function buildBillCatOptions() {
  const one = (type) => parentsOf(type).map((p) => {
    const kids = childrenOf(p.id);
    if (!kids.length) return `<option value="${p.id}">${escapeHtml(p.icon + ' ' + p.name)}</option>`;
    return `<optgroup label="${escapeHtml(p.icon + ' ' + p.name)}">`
      + `<option value="${p.id}">${escapeHtml(p.name)}（整个大类）</option>`
      + kids.map((k) => `<option value="${k.id}">${escapeHtml(k.icon + ' ' + k.name)}</option>`).join('')
      + '</optgroup>';
  }).join('');
  return { expense: one('expense'), income: one('income') };
}

// 共用 option 串里没法逐行标 selected，渲染后统一按数据回填
function syncBillSelects() {
  if (!billDraft) return;
  $$('#bill-rows .bill-cat').forEach((s) => {
    const row = billDraft.rows[Number(s.dataset.billCat)];
    if (row) s.value = row.categoryId;
  });
}

async function onBillFile(file) {
  billError = null;
  billLoading = true;
  render();
  await new Promise((r) => setTimeout(r, 0)); // 先把「解析中」画出来，大文件时不会像卡死
  let parsed = null;
  try {
    parsed = await readBillFile(file);
  } catch (err) {
    billError = { fileName: file.name, diffs: [err && err.message ? err.message : String(err)] };
  }
  billLoading = false;
  if (parsed) {
    // 硬闸门。要求 checked：顶部没找到自带汇总的账单无法自证，同样拒绝 ——
    // 否则一份结构变了的文件会「对账通过（因为没有账可对）」而悄悄记错。
    if (!parsed.checked) {
      billError = { fileName: file.name, diffs: ['这份文件里没找到账单自带的汇总数字，无法核对，出于安全没有导入。请确认导出的是微信或支付宝的原始账单文件。'] };
    } else if (!parsed.ok) {
      billError = { fileName: file.name, diffs: parsed.diffs };
    } else {
      billDraft = buildBillDraft(parsed, file.name);
    }
  }
  render();
  window.scrollTo(0, 0);
}

function buildBillDraft(parsed, fileName) {
  billCatOptions = buildBillCatOptions();
  const records = parsed.records;
  markDuplicates(records, transactions);
  return {
    fileName,
    source: parsed.source,
    encoding: parsed.encoding,
    skipped: parsed.skipped,
    calc: parsed.calc,
    accountId: defaultAccountFor(parsed.source),
    batchId: Date.now(),
    rows: records.map((rec) => ({
      rec,
      // 默认勾选（产品决策）：
      //   支付宝「账户存取」是自己账户间挪钱，既非收入也非支出 → 不勾
      //   已经导过 / 疑似重复 → 不勾，交给用户判断
      //   退款、微信转账红包 → 照勾并打标记
      checked: !rec.alreadyImported && !rec.suspectDup && !rec.tags.includes('internal'),
      categoryId: safeCat(suggestCategory(rec, merchantRules), rec.type),
    })),
  };
}

function renderImportPage() {
  return billDraft ? renderImportReview() : renderImportPick();
}

function renderImportPick() {
  return `
  <div class="page manage-page import-page">
    <div class="page-head"><button class="link-btn" data-action="back-settings">‹ 返回</button><span class="page-title">导入账单</span></div>

    <div class="about-hero">
      <div class="about-logo">🧾</div>
      <div class="about-name">导入微信 / 支付宝账单</div>
      <div class="about-slogan">一次把一个月记进来，不用一条条敲</div>
    </div>

    <div class="set-group"><div class="set-title">先说清楚</div><div class="set-card">
      <div class="about-block">解析和入库<b>全部在这台手机里完成</b>：账单文件不会被上传到任何服务器，也不会联网。导入前你可以逐条核对、改分类、取消勾选；导错了还能一键撤销。</div>
    </div></div>

    <div class="set-group"><div class="set-title">微信怎么导出</div><div class="set-card">
      <div class="about-block">微信 → 我 → 服务 → 钱包 → 账单 → 右上角「…」→ 账单下载 → 选「用于个人对账」→ 下载得到一个<b>压缩包</b>。<br><br>⚠️ 微信发来的是<b>加密压缩包</b>，浏览器解不开，请先用手机上的文件管理器把它<b>解压出 .xlsx</b>，再回来选这个 xlsx。</div>
    </div></div>

    <div class="set-group"><div class="set-title">支付宝怎么导出</div><div class="set-card">
      <div class="about-block">支付宝 → 我的 → 账单 → 右上角「…」→ 开具交易流水证明 → 选「用于个人对账」→ 填邮箱，收到邮件后把 <b>.csv</b> 存到手机。</div>
    </div></div>

    ${billError ? renderBillError() : ''}
    ${billLoading ? '<div class="empty">正在解析账单…</div>' : ''}

    <button class="primary-btn full" data-action="pick-bill">选择账单文件</button>
    <div class="import-note">支持 .xlsx（微信）和 .csv（支付宝）</div>
  </div>`;
}

function renderBillError() {
  return `<div class="set-group"><div class="set-card import-error">
    <div class="import-err-title">❌ 这份账单没通过核对，已拒绝导入</div>
    <div class="import-err-file">${escapeHtml(billError.fileName)}</div>
    <ul class="import-err-list">${billError.diffs.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
    <div class="about-block">为安全起见没有导入任何一条 —— 对不上账说明格式可能变了，记错账比没记更麻烦。</div>
  </div></div>`;
}

function renderImportReview() {
  const d = billDraft;
  const src = BILL_SOURCES[d.source] || BILL_SOURCES.unknown;
  const dates = d.rows.map((r) => r.rec.date).sort();
  // 顶部要显示**实际入库口径**，否则会和底部汇总条对不上（看着像 bug）。
  // 退款行已被 bill.js 转成负数支出，所以这里不能直接用 d.calc ——
  // d.calc 是账单原始口径，拿来对账的，两者在含退款时会差一笔。
  let refCount = 0;
  let refCents = 0;
  d.rows.forEach((r) => {
    if (r.rec.refund) { refCount++; refCents += -r.rec.amountCents; }
  });
  const effExpense = d.calc.expense.cents - refCents;
  const effIncome = d.calc.income.cents - refCents;
  const acctOptions = accounts.map((a) =>
    `<option value="${a.id}" ${d.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.icon + ' ' + a.name)}</option>`).join('');
  return `
  <div class="page manage-page import-page">
    <div class="page-head"><button class="link-btn" data-action="bill-reset">‹ 重选文件</button><span class="page-title">确认导入</span></div>

    <div class="set-group"><div class="set-card import-summary">
      <div class="import-head">
        <span class="import-src">${src.icon} ${src.name}</span>
        <span class="import-idx">共 ${d.rows.length} 条</span>
      </div>
      <div class="import-nums">
        <div><span>支出</span><b class="is-out">${fmtMoney(effExpense)}</b></div>
        <div><span>收入</span><b class="is-in">${fmtMoney(effIncome)}</b></div>
      </div>
      <div class="import-range">${escapeHtml(dates[0] || '')} ~ ${escapeHtml(dates[dates.length - 1] || '')}${
        d.skipped.length ? ` · 已剔除 ${d.skipped.length} 条不计收支` : ''}${
        d.encoding === 'gbk' ? ' · 编码 GBK 已自动识别' : ''}</div>
      <div class="import-ok">✅ 已与账单自带的汇总逐项核对一致${
        refCount ? `（账单口径：支出 ${fmtMoney(d.calc.expense.cents)} / 收入 ${fmtMoney(d.calc.income.cents)}）` : ''}</div>
      ${refCount ? `<div class="import-range">含 ${refCount} 笔退款，按负数支出计入，已从支出中扣除</div>` : ''}
    </div></div>

    <div class="set-group"><div class="set-card">
      <div class="set-row"><span>账户（整批统一）</span>
        <select id="bill-account" data-bill-account="1">${acctOptions}</select>
      </div>
    </div></div>

    <div class="bill-bulk">
      <button class="ghost-btn" data-action="bill-all">全选</button>
      <button class="ghost-btn" data-action="bill-none">全不选</button>
      <button class="ghost-btn" data-action="bill-drop">不导入转账/红包</button>
    </div>

    <div class="bill-list" id="bill-rows">${renderBillRows()}</div>

    <div class="bill-footer" id="bill-footer">${billFooterHtml()}</div>
  </div>`;
}

function renderBillRows() {
  if (!billDraft.rows.length) return emptyHint('这份账单里没有可导入的收支记录');
  return billDraft.rows.map((row, i) => {
    const r = row.rec;
    const income = r.type === 'income';
    // 退款已被 bill.js 转成负数支出：分类要按支出类选，金额显示成「+¥20.00」。
    // 不能让它走到下面 income 那条分支，否则会渲染出「−−¥20.00」这种双重负号。
    const refund = !!r.refund;
    const tags = [];
    if (r.tags.includes('refund')) tags.push('<span class="bill-tag tag-refund">⚠️ 退款</span>');
    if (r.tags.includes('p2p')) tags.push('<span class="bill-tag tag-p2p">转账/红包</span>');
    if (r.tags.includes('internal')) tags.push('<span class="bill-tag tag-internal">账户挪动</span>');
    if (r.alreadyImported) tags.push('<span class="bill-tag tag-dup">已经导过</span>');
    else if (r.suspectDup) tags.push('<span class="bill-tag tag-dup">疑似重复</span>');
    const title = r.party || r.product || '（无商户名）';
    const sub = [r.date, r.product && r.product !== r.party ? r.product : ''].filter(Boolean).join(' · ');
    const opts = income ? billCatOptions.income : billCatOptions.expense;
    return `<div class="bill-row${row.checked ? '' : ' is-off'}" data-bill-row="${i}">
      <input type="checkbox" class="bill-check" data-bill-check="${i}"${row.checked ? ' checked' : ''} aria-label="勾选这条">
      <div class="bill-main">
        <div class="bill-top">
          <span class="bill-party">${escapeHtml(title)}</span>
          <span class="bill-amount ${income || refund ? 'is-in' : 'is-out'}">${income || refund ? '+' : '−'}${fmtMoney(Math.abs(r.amountCents))}</span>
        </div>
        <div class="bill-sub">${escapeHtml(sub)}</div>
        ${tags.length ? `<div class="bill-tags">${tags.join('')}</div>` : ''}
      </div>
      <select class="bill-cat" data-bill-cat="${i}" aria-label="分类">${opts}</select>
    </div>`;
  }).join('');
}

function billFooterHtml() {
  const picked = billDraft.rows.filter((r) => r.checked);
  let out = 0;
  picked.forEach((r) => { if (r.rec.type !== 'income') out += r.rec.amountCents; });
  return `
    <div class="bill-foot-nums">
      <span>已选 <b>${picked.length}</b> / ${billDraft.rows.length} 条</span>
      <span>支出 <b class="is-out">${fmtMoney(out)}</b></span>
    </div>
    <button class="primary-btn full" data-action="bill-commit"${picked.length ? '' : ' disabled'}>确认导入 ${picked.length} 条</button>`;
}

function updateBillFooter() {
  const f = $('#bill-footer');
  if (f && billDraft) f.innerHTML = billFooterHtml();
}

// 整列表重渲染（全选/全不选这类批量操作才用）。
// 单行勾选不走这里 —— 那会丢焦点，也会让长列表卡。
function refreshBillList() {
  const box = $('#bill-rows');
  if (!box || !billDraft) return;
  box.innerHTML = renderBillRows();
  syncBillSelects();
  updateBillFooter();
}

function onBillRowCheck(input) {
  if (!billDraft) return;
  const row = billDraft.rows[Number(input.dataset.billCheck)];
  if (!row) return;
  row.checked = input.checked;
  const box = input.closest('[data-bill-row]');
  if (box) box.classList.toggle('is-off', !row.checked);
  updateBillFooter();
}

function onBillRowCat(sel) {
  if (!billDraft) return;
  const row = billDraft.rows[Number(sel.dataset.billCat)];
  if (row) row.categoryId = sel.value;
}

async function commitBillImport() {
  if (!billDraft) return;
  const picked = billDraft.rows.filter((r) => r.checked);
  if (!picked.length) { toast('还没有勾选任何记录'); return; }
  if (!billDraft.accountId) { toast('请先选择账户'); return; }

  const batchId = billDraft.batchId;
  const list = picked.map((r) => {
    const t = toTxn(r.rec, { categoryId: r.categoryId, accountId: billDraft.accountId, batchId });
    t.id = uid();
    return t;
  });

  // 学习：把「商户 → 用户最终选的分类」记下来，下次导入优先于内置关键词。
  // 只对支出学 —— 收入的分类通常由类型决定，记下来反而会污染规则。
  const next = { ...merchantRules };
  let changed = 0;
  picked.forEach((r) => {
    const m = (r.rec.party || '').trim().slice(0, 80);
    if (!m || r.rec.type !== 'expense') return;
    if (next[m] !== r.categoryId) { next[m] = r.categoryId; changed++; }
  });

  await db.txns.bulkAdd(list);
  if (changed) {
    merchantRules = next;
    await db.settings.set('merchantRules', merchantRules);
  }

  billDraft = null;
  await loadData();
  render();
  showImportDone(list.length, batchId, changed);
}

function showImportDone(count, batchId, learned) {
  showModal({
    title: '导入完成',
    body: `<div class="confirm-msg">已导入 <b>${count}</b> 条记录。${
      learned ? `<br><span class="import-hint">顺便记住了 ${learned} 个商户的分类，下次导入会自动套用。</span>` : ''
    }<br><span class="import-hint">如果结果不对，可以在下面撤销；撤销只影响这一次导入的这 ${count} 条。</span></div>`,
    actions: [
      { label: '撤销本次导入', class: 'danger-btn', onClick: () => { hideModal(); undoImport(batchId); } },
      { label: '好', class: 'primary-btn', onClick: hideModal },
    ],
  });
}

async function undoImport(batchId) {
  const ids = transactions.filter((t) => t.importBatch === batchId).map((t) => t.id);
  if (!ids.length) { toast('没有找到这次导入的记录'); return; }
  await db.txns.removeMany(ids);
  await loadData();
  render();
  toast(`已撤销 ${ids.length} 条`);
}

// ================= 事件绑定 =================
function buildModal() {
  const backdrop = el('<div class="sheet-backdrop hidden" id="modal-backdrop"></div>');
  const modal = el(`
    <div class="modal hidden" id="modal">
      <div class="modal-head"><div class="modal-title" id="modal-title"></div><button class="link-btn" id="modal-close">✕</button></div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-foot" id="modal-foot"></div>
    </div>`);
  document.body.append(backdrop, modal);
  $('#modal-backdrop').addEventListener('click', hideModal);
  $('#modal-close').addEventListener('click', hideModal);
}

let importInput = null;
function buildImportInput() {
  importInput = document.createElement('input');
  importInput.id = 'import-json-input';
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  document.body.appendChild(importInput);
  importInput.addEventListener('change', () => {
    if (importInput.files[0]) importJSON(importInput.files[0]);
    importInput.value = '';
  });
}

// 账单文件和 JSON 备份分开两个 input：accept 不同，混用会让手机文件选择器
// 把 .xlsx / .csv 灰掉
let billInput = null;
function buildBillInput() {
  billInput = document.createElement('input');
  billInput.id = 'bill-file-input';
  billInput.type = 'file';
  billInput.accept = '.xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
  billInput.style.display = 'none';
  document.body.appendChild(billInput);
  billInput.addEventListener('change', () => {
    if (billInput.files[0]) onBillFile(billInput.files[0]);
    billInput.value = ''; // 清空才能连续选同一个文件
  });
}

function bindEvents() {
  $$('#tabbar .tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#fab').addEventListener('click', () => openSheet());
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#sheet-cancel').addEventListener('click', closeSheet);
  $('#sheet-save').addEventListener('click', saveSheet);
  $('#type-expense').addEventListener('click', () => setSheetType('expense'));
  $('#type-income').addEventListener('click', () => setSheetType('income'));
  $('#sheet-amount').addEventListener('input', sanitizeAmount);
  // 勾选态要同步回 state，saveSheet 读的是它；高亮由 CSS 的 :has() 负责，不必重渲染
  $('#sheet-refund').addEventListener('change', (e) => { state.sheetRefund = e.target.checked; });
  $('#sheet-cats').addEventListener('click', onCatAreaClick);
  $('#sheet-accounts').addEventListener('click', onAccountAreaClick);
  $('#view').addEventListener('click', onViewClick);
  $('#view').addEventListener('change', onViewChange);
  $('#view').addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('cb-input')) updateCatBudgetSummary();
  });
  $('#modal-body').addEventListener('click', (e) => {
    const p = e.target.closest('.icon-preview');
    if (p) openIconPicker(p.dataset.target, p.dataset.context);
  });
}

function onCatAreaClick(e) {
  const parent = e.target.closest('.cat-parent');
  if (parent) {
    const pid = parent.dataset.id;
    if (childrenOf(pid).length === 0) state.sheetCategoryId = pid;
    else state.sheetExpanded = state.sheetExpanded === pid ? null : pid;
    renderCatArea();
    return;
  }
  const child = e.target.closest('.cat-child');
  if (child) { state.sheetCategoryId = child.dataset.id; renderCatArea(); }
}

function onAccountAreaClick(e) {
  const chip = e.target.closest('.chip');
  if (chip) { state.sheetAccountId = chip.dataset.id; renderAccountChips(); }
}

function onViewChange(e) {
  const t = e.target;
  if (t.id === 'f-cat') { state.fCategory = t.value; render(); }
  else if (t.id === 'f-acct') { state.fAccount = t.value; render(); }
  else if (t.id === 'f-month') { state.fMonth = t.value; render(); }
  // 账单待确认行的勾选框与分类下拉。这两者都在 change 里处理，
  // 且它们的祖先上都没有 data-action —— 否则点开下拉框会顺带触发那个动作。
  else if (t.dataset.billCheck !== undefined) onBillRowCheck(t);
  else if (t.dataset.billCat !== undefined) onBillRowCat(t);
  else if (t.dataset.billAccount !== undefined && billDraft) billDraft.accountId = t.value;
}

async function onViewClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const id = t.dataset.id;
  switch (action) {
    case 'go-list': switchTab('list'); break;
    case 'go-settings': switchTab('settings'); break;
    case 'set-ftype': state.fType = t.dataset.val; render(); break;
    case 'set-period': state.period = t.dataset.period; render(); break;
    case 'edit-txn': openSheet(id); break;
    case 'copy-txn': copyTxn(id); break;
    case 'delete-txn': await deleteTxn(id); break;
    case 'set-budget': await saveBudget(); break;
    case 'manage-cats': state.subpage = 'cats'; render(); break;
    case 'manage-accts': state.subpage = 'accts'; render(); break;
    case 'manage-catbudgets': state.subpage = 'catbudgets'; render(); break;
    case 'save-catbudgets': await saveCategoryBudgets(); break;
    case 'open-about': state.subpage = 'about'; render(); break;
    case 'back-settings': state.subpage = null; render(); break;
    case 'add-parent': openCategoryModal({ type: t.dataset.type || 'expense' }); break;
    case 'add-child': openCategoryModal({ type: (catById(t.dataset.parent) || {}).type || 'expense', presetParentId: t.dataset.parent }); break;
    case 'edit-cat': openCategoryModal({ catId: id }); break;
    case 'del-cat': await deleteCategory(id); break;
    case 'add-acct': openAccountModal(null); break;
    case 'edit-acct': openAccountModal(id); break;
    case 'del-acct': await deleteAccount(id); break;
    case 'export-json': exportJSON(); break;
    case 'import-json': importInput.click(); break;
    case 'export-csv': exportCSV(); break;
    // —— 账单导入 ——
    case 'open-import': billDraft = null; billError = null; state.subpage = 'import'; render(); break;
    case 'bill-reset': billDraft = null; billError = null; render(); window.scrollTo(0, 0); break;
    case 'pick-bill': if (billInput) billInput.click(); break;
    case 'bill-all': if (billDraft) { billDraft.rows.forEach((r) => { r.checked = true; }); refreshBillList(); } break;
    case 'bill-none': if (billDraft) { billDraft.rows.forEach((r) => { r.checked = false; }); refreshBillList(); } break;
    case 'bill-drop': if (billDraft) {
      // 内部账户挪动本来就是默认不勾的，这个按钮的实际作用是再拿掉微信的转账/红包
      billDraft.rows.forEach((r) => {
        if (r.rec.tags.includes('internal') || r.rec.tags.includes('p2p')) r.checked = false;
      });
      refreshBillList();
    } break;
    case 'bill-commit': await commitBillImport(); break;
    case 'undo-import': await undoImport(Number(t.dataset.batch)); break;
  }
}

// ================= 启动 =================
// 注册 Service Worker。sw.js 一直存在，但此前没人调用它 —— 于是「离线可用」
// 只写在 README 里，代码里一行都没兑现，断网直接是 ERR_INTERNET_DISCONNECTED。
//
// 用 import.meta.url 而不是 './sw.js' 定位：前者的解析基准是这个模块文件本身，
// 不管页面从哪个路径打开都对；后者以文档 URL 为基准，换路径就会失效。
//
// 注册失败只警告、不抛：离线是加分项，不是启动前提。App 必须照常可用，
// 否则一个不支持 SW 的浏览器（或隐私模式）就会整站打不开。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url))
    .catch((err) => console.warn('Service Worker 注册失败，离线能力不可用：', err));
}

async function init() {
  buildModal();
  buildIconPicker();
  buildImportInput();
  buildBillInput();
  bindEvents();
  await ensureSeeded();
  await loadData();
  render();
  // 不 await：注册是后台的事，首屏不该等它
  registerServiceWorker();
}
init();
