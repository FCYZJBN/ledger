// 应用主逻辑：视图渲染、记账、明细、统计、设置、导入导出
import * as db from './db.js';
import { ensureSeeded } from './seed.js';
import { renderCategoryPie, renderTrend } from './charts.js';
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

// ---------- 状态 ----------
const state = {
  tab: 'home',
  subpage: null, // settings 下的子页：null | 'cats' | 'accts'
  // 记账弹层
  editingId: null,
  sheetType: 'expense',
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

// ---------- 数据加载 ----------
async function loadData() {
  const [t, c, a, budget] = await Promise.all([
    db.txns.all(), db.categories.all(), db.accounts.all(),
    db.settings.get('monthlyBudget', 0),
  ]);
  transactions = t;
  categories = c;
  accounts = a;
  budgetAmount = budget;
  transactions.sort((x, y) => y.date.localeCompare(x.date) || (y.createdAt || 0) - (x.createdAt || 0));
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
    const pct = Math.min(100, Math.round(ratio * 100));
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

function txnRow(t) {
  const c = catById(t.categoryId);
  const icon = c ? c.icon : '❓';
  const color = safeColor(c ? c.color : '#999');
  const name = catFullName(t.categoryId);
  const acct = acctById(t.accountId);
  const isExpense = t.type === 'expense';
  const sign = isExpense ? '-' : '+';
  const amountCls = isExpense ? 'amount-out' : 'amount-in';
  return `
  <div class="txn" data-action="edit-txn" data-id="${t.id}">
    <span class="txn-ico" style="background:${color}22;color:${color}">${escapeHtml(icon)}</span>
    <div class="txn-main">
      <div class="txn-name">${escapeHtml(name)}</div>
      <div class="txn-sub">${escapeHtml(acct ? acct.name : '')}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
    </div>
    <div class="txn-right">
      <div class="txn-amount ${amountCls}">${sign}${fmtMoneyShort(t.amount)}</div>
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
          <div class="day-head"><span>${dateLabel(date)}</span><span class="day-sum">${de > 0 ? '支出 ' + fmtMoney(de) : ''}</span></div>
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
  if (state.subpage === 'about') return renderAbout();
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
      <div class="set-title">管理</div>
      <div class="set-card">
        <button class="set-row arrow" data-action="manage-cats">📂 分类管理 <span>›</span></button>
        <button class="set-row arrow" data-action="manage-accts">💳 账户管理 <span>›</span></button>
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
      <div class="about-block"><b>1.</b> 点底部 ＋，输入金额、选分类、选账户，保存即可（默认今天）。<br><b>2.</b> 首页看本月收支与预算，明细按日期回看，统计看图表。<br><b>3.</b> 设置里可自定义分类、账户，设每月预算帽。</div>
    </div></div>

    <div class="set-group"><div class="set-title">数据安全</div><div class="set-card">
      <div class="about-block">所有数据存在<b>本机浏览器</b>（IndexedDB），不会上传云端。请定期到「设置 → 导出备份（JSON）」保存；<b>换手机或清理浏览器数据前务必先备份</b>，再到新设备导入即可恢复。</div>
    </div></div>

    <div class="set-group"><div class="set-title">小技巧</div><div class="set-card">
      <div class="about-block">• 添加到主屏幕：浏览器菜单 →「添加到主屏幕」，之后像 App 一样全屏、离线使用。<br>• 预算帽只提醒不拦截：用掉 80% 进度条变黄、超支变红。<br>• 分类支持两级：大类下还能建子类，图标一键点选、也可自定义。</div>
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
      state.sheetCategoryId = t.categoryId;
      state.sheetAccountId = t.accountId;
      state.sheetExpanded = null;
      $('#sheet-amount').value = fmtMoneyShort(t.amount);
      $('#sheet-date').value = t.date;
      $('#sheet-note').value = t.note || '';
    }
  } else {
    state.sheetType = prefill ? (prefill.type || 'expense') : 'expense';
    state.sheetCategoryId = prefill ? (prefill.categoryId || null) : null;
    state.sheetAccountId = prefill ? (prefill.accountId || accounts[0]?.id || null) : (accounts[0]?.id || null);
    state.sheetExpanded = null;
    $('#sheet-amount').value = prefill && prefill.amount ? fmtMoneyShort(prefill.amount) : '';
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
  const amount = parseAmount($('#sheet-amount').value);
  if (amount <= 0) { toast('请输入金额'); return; }
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
  if (state.editingId) await db.txns.update(txn);
  else await db.txns.add(txn);
  closeSheet();
  await loadData();
  render();
  toast('已保存');
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
function hideModal() {
  $('#modal').classList.add('hidden');
  $('#modal-backdrop').classList.add('hidden');
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    showModal({
      title: '确认',
      body: `<div class="confirm-msg">${escapeHtml(message)}</div>`,
      actions: [
        { label: '取消', class: 'link-btn', onClick: () => { hideModal(); resolve(false); } },
        { label: '确定', class: 'danger-btn', onClick: () => { hideModal(); resolve(true); } },
      ],
    });
  });
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

  const txns = (Array.isArray(raw.transactions) ? raw.transactions : []).map((t) => ({
    id: uid(),
    type: t.type === 'income' ? 'income' : 'expense',
    amount: Number.isFinite(t.amount) ? Math.max(0, Math.round(t.amount)) : 0,
    categoryId: catIdMap.get(t.categoryId) || '',
    accountId: acctIdMap.get(t.accountId) || '',
    date: validDate(t.date) ? t.date : todayStr(),
    note: asString(t.note, '').slice(0, 200),
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : Date.now(),
  }));

  const budget = Number.isFinite(raw.budget) ? Math.max(0, Math.round(raw.budget)) : null;
  return { categories: cats, accounts: accts, transactions: txns, budget };
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
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  document.body.appendChild(importInput);
  importInput.addEventListener('change', () => {
    if (importInput.files[0]) importJSON(importInput.files[0]);
    importInput.value = '';
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
  $('#sheet-cats').addEventListener('click', onCatAreaClick);
  $('#sheet-accounts').addEventListener('click', onAccountAreaClick);
  $('#view').addEventListener('click', onViewClick);
  $('#view').addEventListener('change', onViewChange);
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
  }
}

// ================= 启动 =================
async function init() {
  buildModal();
  buildIconPicker();
  buildImportInput();
  bindEvents();
  await ensureSeeded();
  await loadData();
  render();
}
init();
