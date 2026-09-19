// 端到端冒烟测试：启动无头 Chrome + CDP，验证「渲染 → 记一笔 → 统计图表」全链路
import { spawn } from 'node:child_process';
import { WECHAT_XLSX, ALIPAY_CSV_GBK, ALIPAY_BAD_TOTAL_CSV_GBK } from './sample-bills.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.SMOKE_URL || 'http://localhost:8001/';
const PORT = 9333;
const PROFILE = 'C:/Users/FCYZJBN/AppData/Local/Temp/ledger-chrome-' + Date.now();

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  URL,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('no CDP target');
}

let results = [];

async function main() {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push((msg.params.exceptionDetails.exception?.description) || msg.params.exceptionDetails.text);
    }
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    // 页内异常必须冒出来，否则只会表现为一个莫名其妙的 undefined
    if (r.exceptionDetails) {
      exceptions.push('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  };

  await send('Runtime.enable');

  // 就绪等待：线上首次加载要装 Service Worker + 拉图表库，比本地慢得多
  const waitFor = async (expr, timeout = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evalJs(expr)) return true;
      await sleep(250);
    }
    return false;
  };
  const appReady = await waitFor(`document.querySelectorAll('#tabbar .tab').length === 4 && ((document.querySelector('#view')||{}).innerHTML||'').length > 0`);
  if (!appReady) { console.error('SMOKE FAIL: 应用未在超时内完成渲染'); chrome.kill(); process.exit(1); }

  // 1. 首页渲染
  const home = JSON.parse(await evalJs(`JSON.stringify({
    viewLen: (document.querySelector('#view')||{}).innerHTML?.length || 0,
    hasOverview: !!document.querySelector('.overview-card'),
    hasBudget: !!document.querySelector('.budget-card'),
    emptyHint: (document.querySelector('#view')||{}).textContent?.includes('还没有记录') || false,
  })`));
  results.push(['首页渲染', home.viewLen > 0 && home.hasOverview && home.hasBudget && home.emptyHint, home]);

  // 2. 记一笔
  await evalJs(`document.querySelector('#fab').click()`);
  await sleep(400);
  const sheetOpen = await evalJs(`!document.querySelector('#sheet').classList.contains('hidden')`);
  await evalJs(`(() => { const i = document.querySelector('#sheet-amount'); i.value = '25.50'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelector('.cat-parent').click()`); // 展开第一个大类
  await sleep(200);
  const childShown = await evalJs(`!!document.querySelector('.cat-child')`);
  await evalJs(`document.querySelector('.cat-child').click()`); // 选子类
  await sleep(150);
  await evalJs(`document.querySelector('#sheet-save').click()`);
  await sleep(600);

  const saved = JSON.parse(await evalJs(`JSON.stringify({
    sheetHidden: document.querySelector('#sheet').classList.contains('hidden'),
    txnCount: document.querySelectorAll('.txn').length,
    has25: document.querySelector('#view').textContent.includes('25.50'),
  })`));
  results.push(['记一笔保存', sheetOpen && childShown && saved.sheetHidden && saved.txnCount === 1 && saved.has25, saved]);

  // 3. 切到明细，确认分组 + 删除按钮
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'list').click()`);
  await sleep(300);
  const list = JSON.parse(await evalJs(`JSON.stringify({
    dayGroups: document.querySelectorAll('.day-group').length,
    copyBtn: !!document.querySelector('[data-action="copy-txn"]'),
    delBtn: !!document.querySelector('[data-action="delete-txn"]'),
  })`));
  results.push(['明细列表', list.dayGroups === 1 && list.copyBtn && list.delBtn, list]);

  // 4. 统计页图表
  await waitFor(`typeof echarts !== 'undefined'`);
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'stats').click()`);
  await sleep(900);
  const stats = JSON.parse(await evalJs(`JSON.stringify({
    cards: document.querySelectorAll('.stat-card').length,
    pieCanvas: !!document.querySelector('#pie-chart canvas'),
    trendCanvas: !!document.querySelector('#trend-chart canvas'),
  })`));
  results.push(['统计图表', stats.cards === 4 && stats.pieCanvas && stats.trendCanvas, stats]);

  // 5. 设置 → 关于/使用帮助页
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  await evalJs(`document.querySelector('[data-action="open-about"]').click()`);
  await sleep(300);
  const about = JSON.parse(await evalJs(`JSON.stringify({
    hasHero: !!document.querySelector('.about-hero'),
    hasTitle: document.querySelector('#view').textContent.includes('使用帮助'),
    backBtn: !!document.querySelector('[data-action="back-settings"]'),
  })`));
  results.push(['关于/帮助页', about.hasHero && about.hasTitle && about.backBtn, about]);

  // 6. 分类管理 → 新增大类 → 图标点选面板
  await evalJs(`document.querySelector('[data-action="back-settings"]').click()`);
  await sleep(200);
  await evalJs(`document.querySelector('[data-action="manage-cats"]').click()`);
  await sleep(200);
  await evalJs(`document.querySelector('[data-action="add-parent"][data-type="expense"]').click()`);
  await sleep(300);
  const modalOpen = await evalJs(`!document.querySelector('#modal').classList.contains('hidden')`);
  const hasPreview = await evalJs(`!!document.querySelector('#c-icon-preview')`);
  await evalJs(`document.querySelector('#c-icon-preview').click()`);
  await sleep(300);
  const pickerOpen = await evalJs(`!document.querySelector('#icon-picker').classList.contains('hidden')`);
  const gridCount = await evalJs(`document.querySelectorAll('#icon-picker-grid .ip-item').length`);
  const firstEmoji = await evalJs(`document.querySelector('#icon-picker-grid .ip-item').dataset.emoji`);
  await evalJs(`document.querySelector('#icon-picker-grid .ip-item').click()`);
  await sleep(200);
  const pickerClosed = await evalJs(`document.querySelector('#icon-picker').classList.contains('hidden')`);
  const previewEmoji = await evalJs(`document.querySelector('#c-icon-preview .ip-emoji').textContent`);
  results.push(['图标点选面板', modalOpen && hasPreview && pickerOpen && gridCount > 10 && pickerClosed && firstEmoji === previewEmoji, { modalOpen, hasPreview, pickerOpen, gridCount, firstEmoji, previewEmoji }]);

  // 7. 分类预算：设置 → 保存 → 首页出现进度条
  await evalJs(`document.querySelector('[data-action="back-settings"]').click()`);
  await sleep(200);
  await evalJs(`document.querySelector('[data-action="manage-catbudgets"]').click()`);
  await sleep(300);
  const mgr = JSON.parse(await evalJs(`JSON.stringify({
    rows: document.querySelectorAll('.cb-input').length,
    emptyPlaceholder: document.querySelector('.cb-input').placeholder,
  })`));
  // 给第一个支出大类（餐饮）设 30 元预算：已花 25.50，尚未超支（应为黄色 warn 状态）
  await evalJs(`(() => { const i = document.querySelector('.cb-input'); i.value = '30'; })()`);
  await evalJs(`document.querySelector('[data-action="save-catbudgets"]').click()`);
  await sleep(700);
  const budgetCard = JSON.parse(await evalJs(`JSON.stringify({
    cardShown: !!document.querySelector('.cb-card'),
    rows: document.querySelectorAll('.cb-card .cb-row').length,
    hasOver: !!document.querySelector('.cb-status.over'),
    status: (document.querySelector('.cb-card .cb-status')||{}).textContent || '',
    barWarn: !!document.querySelector('.cb-card .budget-bar-fill.warn'),
    nums: (document.querySelector('.cb-card .cb-nums')||{}).textContent || '',
  })`));
  results.push(['分类预算卡片', mgr.rows >= 9 && mgr.emptyPlaceholder === '不设' && budgetCard.cardShown && budgetCard.rows === 1 && !budgetCard.hasOver && budgetCard.barWarn && budgetCard.status.includes('剩余'), { ...mgr, ...budgetCard }]);

  // 8. 记账跨线提示：再记 5 元同分类（累计 30.50 > 30），应弹「已超预算」且卡片转红
  await evalJs(`document.querySelector('#fab').click()`);
  await sleep(400);
  await evalJs(`(() => { const i = document.querySelector('#sheet-amount'); i.value = '5.00'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelector('.cat-parent').click()`);
  await sleep(200);
  await evalJs(`document.querySelector('.cat-child').click()`);
  await sleep(150);
  await evalJs(`document.querySelector('#sheet-save').click()`);
  await sleep(700);
  const cross = JSON.parse(await evalJs(`JSON.stringify({
    toast: (document.querySelector('#toast')||{}).textContent || '',
    barOver: !!document.querySelector('.cb-card .budget-bar-fill.over'),
    overText: (document.querySelector('.cb-status.over')||{}).textContent || '',
  })`));
  results.push(['记账跨线提示', cross.toast.includes('已超预算') && cross.barOver && cross.overText.includes('已超'), cross]);

  // 9. 导入往返：分类预算的键是分类 id，导入会重建全部 id，预算必须跟着重映射存活
  await evalJs(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ledger-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const get = (s) => new Promise((res, rej) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const cats = await get('categories');
    const accts = await get('accounts');
    const txns = await get('transactions');
    const food = cats.find((c) => c.name === '餐饮' && !c.parentId);
    db.close();
    const payload = { app: '记账本', version: 1, budget: 0, categoryBudgets: { [food.id]: 3000 }, categories: cats, accounts: accts, transactions: txns };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' }));
    const inp = document.querySelector('#import-json-input');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(600);
  await evalJs(`document.querySelector('#modal-foot .danger-btn').click()`);
  await sleep(900);
  const roundtrip = JSON.parse(await evalJs(`JSON.stringify({
    cardShown: !!document.querySelector('.cb-card'),
    rows: document.querySelectorAll('.cb-card .cb-row').length,
    overText: (document.querySelector('.cb-status.over')||{}).textContent || '',
    txnCount: document.querySelectorAll('.txn').length,
  })`));
  results.push(['导入往返保预算', roundtrip.cardShown && roundtrip.rows === 1 && roundtrip.overText.includes('已超') && roundtrip.txnCount === 2, roundtrip]);

  // 10. XSS 回归：把分类名换成 HTML payload，确认全程只作纯文本渲染（toast / 列表 / 分类区都不解析）
  const PAYLOAD = '<img src=x onerror="window.__xss=1">';
  await evalJs(`(async () => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('ledger-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    // getAll 按主键(id)排序，导入后 id 是随机 uid，所以必须按 sortOrder 取，
    // 才能拿到记账弹层里第一个大类（餐饮），否则预算会设到别的分类上
    const cats = await new Promise((res, rej) => {
      const r = db.transaction('categories', 'readonly').objectStore('categories').getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const food = cats.filter((c) => !c.parentId && c.type === 'expense')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];
    // 改名 + 把预算调到刚好差 1 元，下一笔必然跨线，从而触发含分类名的 toast
    await new Promise((res, rej) => {
      const tx = db.transaction(['categories', 'settings'], 'readwrite');
      tx.objectStore('categories').put({ ...food, name: ${JSON.stringify(PAYLOAD)} });
      tx.objectStore('settings').put({ key: 'categoryBudgets', value: { [food.id]: 3100 } });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    db.close();
  })()`);
  await sleep(400);
  await send('Page.reload');
  await sleep(2500);
  await evalJs(`document.querySelector('#fab').click()`);
  await sleep(500);
  await evalJs(`(() => { const i = document.querySelector('#sheet-amount'); i.value = '1.00'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelector('.cat-parent').click()`);
  await sleep(250);
  await evalJs(`document.querySelector('.cat-child').click()`);
  await sleep(200);
  await evalJs(`document.querySelector('#sheet-save').click()`);
  await sleep(800);
  const xss = JSON.parse(await evalJs(`JSON.stringify({
    fired: typeof window.__xss !== 'undefined',
    toastText: (document.querySelector('#toast')||{}).textContent || '',
    toastChildren: (document.querySelector('#toast')||{}).childElementCount,
    injectedImgs: document.querySelectorAll('#toast img, #view img, .cat-area img').length,
    literalInList: (document.querySelector('#view')||{}).textContent.includes('<img'),
  })`));
  results.push(['XSS 注入不生效', !xss.fired && xss.toastChildren === 0 && xss.injectedImgs === 0 && xss.toastText.includes('<img'), xss]);

  // 11. 总预算与分类预算联动：不一致时弹框，选「把总预算改为合计」
  await evalJs(`document.querySelector('#fab') && document.querySelector('#sheet-backdrop').click()`);
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  // 先把总预算设为 ¥100（高于当前已分配，不应弹框）
  await evalJs(`(() => { const i = document.querySelector('#budget-input'); i.value = '100'; })()`);
  await evalJs(`document.querySelector('[data-action="set-budget"]').click()`);
  await sleep(600);
  const noPrompt = await evalJs(`document.querySelector('#modal').classList.contains('hidden')`);
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  await evalJs(`document.querySelector('[data-action="manage-catbudgets"]').click()`);
  await sleep(300);
  // 分类预算改成 ¥130，与总预算 ¥100 不一致 → 应弹框
  await evalJs(`(() => { const i = document.querySelector('.cb-input'); i.value = '130'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const summary = await evalJs(`(document.querySelector('#cb-summary')||{}).textContent || ''`);
  await evalJs(`document.querySelector('[data-action="save-catbudgets"]').click()`);
  await sleep(500);
  const dialog = JSON.parse(await evalJs(`JSON.stringify({
    shown: !document.querySelector('#modal').classList.contains('hidden'),
    text: (document.querySelector('#modal-body')||{}).textContent || '',
    buttons: [...document.querySelectorAll('#modal-foot button')].map(b => b.textContent),
  })`));
  await evalJs(`[...document.querySelectorAll('#modal-foot button')].find(b => b.textContent.includes('把总预算改为')).click()`);
  await sleep(700);
  const synced = JSON.parse(await evalJs(`JSON.stringify({
    budgetCard: (document.querySelector('.budget-nums span')||{}).textContent || '',
    unalloc: (document.querySelector('.cb-unalloc .cb-status')||{}).textContent || '',
    unallocLabel: (document.querySelector('.cb-unalloc')||{}).textContent || '',
  })`));
  results.push(['预算联动提示', noPrompt && summary.includes('超出总预算') && dialog.shown && dialog.text.includes('相差') && dialog.text.includes('超出') && dialog.buttons.length === 2 && synced.budgetCard.includes('130.00') && synced.unalloc === '¥0.00', { noPrompt, summary, ...dialog, ...synced }]);

  // 12. 未分配是「动态余额」：未设预算的分类花钱后应递减（静态差额则不会变）
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  await evalJs(`(() => { const i = document.querySelector('#budget-input'); i.value = '150'; })()`);
  await evalJs(`document.querySelector('[data-action="set-budget"]').click()`);
  await sleep(600);
  const before = await evalJs(`(document.querySelector('.cb-unalloc .cb-status')||{}).textContent || ''`);
  // 在「交通」（未设分类预算）记 ¥5.00
  await evalJs(`document.querySelector('#fab').click()`);
  await sleep(400);
  await evalJs(`(() => { const i = document.querySelector('#sheet-amount'); i.value = '5.00'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelectorAll('.cat-parent')[1].click()`);
  await sleep(250);
  await evalJs(`document.querySelector('.cat-child').click()`);
  await sleep(200);
  await evalJs(`document.querySelector('#sheet-save').click()`);
  await sleep(700);
  const after = JSON.parse(await evalJs(`JSON.stringify({
    unalloc: (document.querySelector('.cb-unalloc .cb-status')||{}).textContent || '',
    over: !!document.querySelector('.cb-unalloc .cb-status.over'),
  })`));
  // 总预算 ¥150 = 已分配 ¥130 + 未分配 ¥20；交通花掉 ¥5 后未分配应剩 ¥15
  results.push(['未分配动态递减', before === '¥20.00' && after.unalloc === '¥15.00' && !after.over, { before, ...after }]);

  // 13. 选「保持总额」：总预算不动，差额记为未分配 → 首页应显示「已超分配」红字
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  await evalJs(`document.querySelector('[data-action="manage-catbudgets"]').click()`);
  await sleep(300);
  await evalJs(`(() => { const i = document.querySelector('.cb-input'); i.value = '200'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelector('[data-action="save-catbudgets"]').click()`);
  await sleep(500);
  await evalJs(`[...document.querySelectorAll('#modal-foot button')].find(b => b.textContent.includes('保持总额')).click()`);
  await sleep(700);
  const kept = JSON.parse(await evalJs(`JSON.stringify({
    budgetCard: (document.querySelector('.budget-nums span')||{}).textContent || '',
    unalloc: (document.querySelector('.cb-unalloc')||{}).textContent || '',
    status: (document.querySelector('.cb-unalloc .cb-status')||{}).textContent || '',
    over: !!document.querySelector('.cb-unalloc .cb-status.over'),
  })`));
  // 总预算仍是 ¥150，分类合计 ¥200 → 超分配 ¥50
  results.push(['联动选保持总额', kept.budgetCard.includes('150.00') && kept.unalloc.includes('已超分配') && kept.status === '¥50.00' && kept.over, kept]);

  // 14. 调低总预算到已分配以下：先「取消」不生效，再「仍然保存」生效（只提醒不拦截）
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  await evalJs(`(() => { const i = document.querySelector('#budget-input'); i.value = '50'; })()`);
  await evalJs(`document.querySelector('[data-action="set-budget"]').click()`);
  await sleep(500);
  const lowWarn = JSON.parse(await evalJs(`JSON.stringify({
    shown: !document.querySelector('#modal').classList.contains('hidden'),
    text: (document.querySelector('#modal-body')||{}).textContent || '',
  })`));
  await evalJs(`[...document.querySelectorAll('#modal-foot button')].find(b => b.textContent.includes('取消')).click()`);
  await sleep(400);
  // 取消后没有跳转，仍在设置页；回首页读总预算
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'home').click()`);
  await sleep(300);
  const afterCancel = await evalJs(`document.querySelector('.budget-nums span').textContent`);
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'settings').click()`);
  await sleep(300);
  await evalJs(`(() => { const i = document.querySelector('#budget-input'); i.value = '50'; })()`);
  await evalJs(`document.querySelector('[data-action="set-budget"]').click()`);
  await sleep(500);
  await evalJs(`[...document.querySelectorAll('#modal-foot button')].find(b => b.textContent.includes('仍然保存')).click()`);
  await sleep(700);
  const afterForce = await evalJs(`document.querySelector('.budget-nums span').textContent`);
  results.push(['总预算低于已分配提醒', lowWarn.shown && lowWarn.text.includes('超分配') && afterCancel.includes('150.00') && afterForce.includes('50.00'), { ...lowWarn, afterCancel, afterForce }]);

  // ================= 账单导入 =================
  //
  // 输入是 base64 内嵌的**合成**样本（scripts/sample-bills.mjs），结构与真实
  // 微信/支付宝账单一致：缺行、Excel 序列号日期、GBK 编码、订单号尾随 TAB、
  // 同日同金额的独立交易。真实账单永远不进仓库。

  // 全程记录网络请求，最后断言「账单不上传」不是一句承诺
  const netRequests = [];
  // 注意：本文件顶部的 const URL 遮蔽了全局 URL 构造器，这里用正则取 origin
  const originOf = (u) => (/^https?:\/\/[^/]+/.exec(String(u)) || [''])[0];
  const pageOrigin = originOf(URL);
  await send('Network.enable');
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') {
      netRequests.push({ url: m.params.request.url, method: m.params.request.method });
    }
  });

  const injectBill = async (b64, fileName, mime) => {
    await evalJs(`(() => {
      const bin = atob(${JSON.stringify(b64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} }));
      const inp = document.querySelector('#bill-file-input');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  };

  const readReview = async () => JSON.parse(await evalJs(`JSON.stringify({
    onReview: !!document.querySelector('#bill-rows'),
    rows: document.querySelectorAll('.bill-row').length,
    checked: [...document.querySelectorAll('.bill-check')].filter((c) => c.checked).length,
    offRows: document.querySelectorAll('.bill-row.is-off').length,
    sumOut: (document.querySelector('.import-nums .is-out')||{}).textContent || '',
    sumIn: (document.querySelector('.import-nums .is-in')||{}).textContent || '',
    range: (document.querySelector('.import-range')||{}).textContent || '',
    foot: ((document.querySelector('.bill-foot-nums')||{}).textContent||'').replace(/\\s+/g,' ').trim(),
    commit: (document.querySelector('[data-action="bill-commit"]')||{}).textContent || '',
    tags: [...document.querySelectorAll('.bill-tag')].map((x) => x.textContent),
    parties: [...document.querySelectorAll('.bill-party')].map((x) => x.textContent),
    imgs: document.querySelectorAll('#bill-rows img').length,
    xssFired: !!window.__billXss,
    errShown: !!document.querySelector('.import-error'),
    errText: ((document.querySelector('.import-error')||{}).textContent||'').replace(/\\s+/g,' ').trim(),
  })`));

  const readTxns = async () => JSON.parse(await evalJs(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ledger-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const t = await new Promise((res, rej) => { const r = db.transaction('transactions','readonly').objectStore('transactions').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    db.close();
    return JSON.stringify(t);
  })()`));

  // 直接往库里塞手记记录，用来验证模糊去重的「组内配额」
  const addManual = async (list) => evalJs(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ledger-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction('transactions','readwrite');
      ${JSON.stringify(list)}.forEach((t) => tx.objectStore('transactions').put(t));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    db.close();
  })()`);

  const gotoImport = async () => {
    await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'settings').click()`);
    await sleep(250);
    await evalJs(`document.querySelector('[data-action="open-import"]').click()`);
    await sleep(250);
  };
  // 只有「待确认」页才有这个按钮；解析失败或被拒绝时按钮不存在，点了会抛异常
  const resetImport = async () => {
    await evalJs(`(() => { const b = document.querySelector('[data-action="bill-reset"]'); if (b) b.click(); })()`);
    await sleep(300);
  };

  await gotoImport();

  // 15. 微信 xlsx：缺行的 <row> 不影响解析，汇总逐项对上。
  //     注意这里的数字是**入库口径**，不是账单口径：账单声明 支出 36 / 收入 220，
  //     其中 20.00 那笔退款被转成了负数支出，所以支出 36-20=16、收入 220-20=200。
  //     bill.js 的对账用的是账单口径（转换发生在对账之后），这里断言的是转换结果。
  await injectBill(WECHAT_XLSX, 'sample-wechat.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  const wx = await readReview();
  results.push(['账单·微信xlsx解析', wx.onReview && wx.rows === 5 && wx.sumOut.includes('16.00')
    && wx.sumIn.includes('200.00') && wx.range.includes('已剔除 1 条')
    && wx.tags.filter((t) => t.includes('退款')).length === 2
    && wx.tags.some((t) => t.includes('转账')), wx]);

  // 15b. 退款行转成负数支出后，顶部与底部汇总必须一致 ——
  //      顶部若继续显示账单口径(36.00)而底部是 16.00，看着就像算错了。
  results.push(['账单·退款顶部底部口径一致', wx.sumOut.includes('16.00') && wx.foot.includes('16.00'),
    { sumOut: wx.sumOut, foot: wx.foot }]);

  // 16. 支付宝 CSV：GBK 自动识别；「账户存取」默认不勾
  await resetImport();
  await injectBill(ALIPAY_CSV_GBK, 'sample-alipay.csv', 'text/csv');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  const ali = await readReview();
  results.push(['账单·支付宝GBK与默认勾选', ali.onReview && ali.rows === 6 && ali.sumOut.includes('396.00')
    && ali.range.includes('GBK') && ali.checked === 5 && ali.offRows === 1
    && ali.tags.some((t) => t.includes('账户挪动')), ali]);

  // 16b. 商户名里的 HTML payload：账单是不可信输入，待确认页必须只当纯文本渲染
  results.push(['账单·商户名XSS不生效', !ali.xssFired && ali.imgs === 0
    && ali.parties.some((p) => p.includes('<img src=x')), {
    fired: ali.xssFired, imgs: ali.imgs, literal: ali.parties.find((p) => p.includes('<img')),
  }]);

  // 17. 硬闸门：汇总对不上的样本必须被拒绝，一条都不许进
  await resetImport();
  await injectBill(ALIPAY_BAD_TOTAL_CSV_GBK, 'sample-bad-total.csv', 'text/csv');
  await sleep(800);
  const bad = await readReview();
  results.push(['账单·对账不通过则拒绝导入', bad.errShown && !bad.onReview
    && bad.errText.includes('已拒绝导入') && bad.errText.includes('99笔'), bad]);

  // 18. 待确认页交互：勾选框与分类下拉都只改数据、不触发别的动作
  await resetImport();
  await injectBill(WECHAT_XLSX, 'sample-wechat.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  const billBefore = await readReview();
  // 取消第一行
  await evalJs(`(() => { const c = document.querySelector('.bill-check'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(250);
  const billUn = await readReview();
  // 勾回来，并把第二行的分类改掉（commit 后按库里的值核对）
  await evalJs(`(() => { const c = document.querySelector('.bill-check'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evalJs(`(() => {
    const s = document.querySelectorAll('.bill-cat')[1];
    const opt = [...s.options].find((o) => o.value && !/（整个大类）/.test(o.textContent));
    s.value = opt.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    window.__pickedCat = opt.value;
  })()`);
  await sleep(250);
  const billRe = await readReview();
  const pickedCat = await evalJs(`window.__pickedCat`);
  results.push(['账单·待确认页交互', billBefore.checked === 5 && billUn.checked === 4 && billUn.foot.includes('已选 4')
    && billRe.checked === 5 && billRe.foot.includes('已选 5') && !!pickedCat, { billBefore: billBefore.foot, billUn: billUn.foot, billRe: billRe.foot, pickedCat }]);

  // 19. 入库：条数、billNo 前缀、备注、以及刚改的那个分类
  const n0 = (await readTxns()).length;
  await evalJs(`document.querySelector('[data-action="bill-commit"]').click()`);
  await sleep(1200);
  const billAfter = await readTxns();
  const billImported = billAfter.filter((t) => t.billNo && t.billNo.startsWith('wx:'));
  const billChanged = billAfter.find((t) => t.categoryId === pickedCat);
  results.push(['账单·入库与字段落库', billAfter.length === n0 + 5 && billImported.length === 5
    && billImported.every((t) => t.importBatch > 0 && t.note)
    && !!billChanged, {
    billBefore: n0, after: billAfter.length, billImported: billImported.length,
    sample: billImported[0] && { billNo: billImported[0].billNo.slice(0, 8), note: billImported[0].note, batch: billImported[0].importBatch > 0 },
  }]);

  // 19b. 导入的退款也要落库成负数支出，而不是一笔收入。
  //      账单里退款是「收入」那行，但经济实质是这笔消费被撤销了。
  //      原始消费那行（支出 20.00）必须原样保留 —— 钱当时确实花出去了。
  const wxRefundRows = billImported.filter((t) => t.amount < 0);
  const wxIncomes = billImported.filter((t) => t.type === 'income');
  results.push(['退款·导入落库为负数支出',
    wxRefundRows.length === 1 && wxRefundRows[0].type === 'expense' && wxRefundRows[0].amount === -2000
    && wxIncomes.length === 1 && wxIncomes[0].amount === 20000,
    { refunds: wxRefundRows.map((t) => ({ type: t.type, amount: t.amount })),
      incomes: wxIncomes.map((t) => t.amount) }]);
  await evalJs(`[...document.querySelectorAll('#modal-foot button')].find((b) => b.textContent.trim() === '好').click()`);
  await sleep(300);

  // 20. 同一份再导一次 → 单号比对全部识别为「已经导过」，默认不勾，记录数不变
  await injectBill(WECHAT_XLSX, 'sample-wechat.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  const billReopen = await readReview();
  await evalJs(`document.querySelector('[data-action="bill-commit"]').click()`);
  await sleep(800);
  const billRedo = await readTxns();
  results.push(['账单·重复导入幂等', billReopen.checked === 0 && billReopen.rows === 5
    && billReopen.tags.filter((t) => t.includes('已经导过')).length === 5
    && billRedo.length === billAfter.length, {
    checked: billReopen.checked, tags: billReopen.tags, txns: billRedo.length,
  }]);

  // 21. 撤销：一次写进 5 条，必须能一次退回
  await resetImport();
  const n1 = (await readTxns()).length;
  await injectBill(ALIPAY_CSV_GBK, 'sample-alipay.csv', 'text/csv');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  await evalJs(`document.querySelector('[data-action="bill-commit"]').click()`);
  await sleep(1200);
  const billAfterAli = (await readTxns()).length;
  await evalJs(`[...document.querySelectorAll('#modal-foot button')].find((b) => b.textContent.includes('撤销')).click()`);
  await sleep(1000);
  const billUndo = await readTxns();
  // 只断言支付宝那批消失 —— 库里还留着前面用例导入的微信记录，它们不该被这次撤销波及
  results.push(['账单·撤销本次导入', billAfterAli === n1 + 5 && billUndo.length === n1
    && !billUndo.some((t) => t.billNo && t.billNo.startsWith('ali:')), {
    before: n1, afterImport: billAfterAli, afterUndo: billUndo.length,
    keptWx: billUndo.filter((t) => t.billNo && t.billNo.startsWith('wx:')).length,
  }]);

  // 22. 组内配额去重：账单里「同日同金额」是两笔独立交易，只有手记的那条能抵消一条。
  //     addManual 直接写库，应用内存里的 transactions 不会自动更新，
  //     所以每次都要 reload 让 loadData 重新拉一遍，否则去重根本看不到手记记录。
  const reloadApp = async () => { await send('Page.reload'); await sleep(2600); await gotoImport(); };
  const manual = (id, note) => ({ id, type: 'expense', amount: 1200, categoryId: '', accountId: '', date: '2026-09-03', note, createdAt: Date.now(), updatedAt: Date.now() });

  await addManual([manual('manual-1', '手记的午餐')]);
  await reloadApp();
  await injectBill(ALIPAY_CSV_GBK, 'sample-alipay.csv', 'text/csv');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  const quota1 = await readReview();

  await addManual([manual('manual-2', '手记的晚餐')]);
  await reloadApp();
  await injectBill(ALIPAY_CSV_GBK, 'sample-alipay.csv', 'text/csv');
  await waitFor(`!!document.querySelector('#bill-rows')`);
  const quota2 = await readReview();
  results.push(['账单·组内配额去重', quota1.tags.filter((t) => t.includes('疑似重复')).length === 1
    && quota2.tags.filter((t) => t.includes('疑似重复')).length === 2, {
    manual1: quota1.tags, manual2: quota2.tags,
  }]);

  // 23. 零出站请求：把「账单不上传」从承诺变成可验证的事实
  const crossOrigin = netRequests.filter((r) => originOf(r.url) !== pageOrigin);
  const writes = netRequests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  results.push(['账单·全程零出站请求', crossOrigin.length === 0 && writes.length === 0, {
    total: netRequests.length, crossOrigin: crossOrigin.map((r) => r.url), writes: writes.map((r) => r.method + ' ' + r.url),
  }]);

  // ============ 退款（手记） ============
  // 退款记成「负数支出」，不是一笔收入。记成收入的唯一好处是结余碰巧对，
  // 但本月支出与收入会同时虚高、分类预算被白白吃掉。下面几条钉住这一点。

  const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
  const gotoHome = async () => {
    await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'home').click()`);
    await sleep(300);
  };
  const readOverview = async () => JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('.ov-item')].map((x) => ((x.querySelector('.ov-val') || {}).textContent || '').trim())
  )`));
  // 走真实弹层录入：金额框只输正数，符号由「退款」勾选框决定
  const sheetRecord = async (amount, refund) => {
    await evalJs(`document.querySelector('#fab').click()`);
    await sleep(400);
    await evalJs(`(() => { const i = document.querySelector('#sheet-amount'); i.value = '${amount}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    if (refund) {
      await evalJs(`(() => { const c = document.querySelector('#sheet-refund'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    }
    await evalJs(`document.querySelector('.cat-parent').click()`);
    await sleep(200);
    await evalJs(`(document.querySelector('.cat-child') || document.querySelector('.cat-parent')).click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#sheet-save').click()`);
    await sleep(700);
  };

  await gotoHome();
  const ovBase = await readOverview();
  await sheetRecord('100.00', false);      // 花掉 100
  await gotoHome();
  const ovSpent = await readOverview();
  await sheetRecord('100.00', true);       // 全额退回
  await gotoHome();
  const ovRefunded = await readOverview();

  // 支出被减回原值，且**收入完全没动** —— 后者才是「不该记成收入」的关键。
  results.push(['退款·抵减支出而非计入收入',
    num(ovSpent[0]) === num(ovBase[0]) + 100
    && num(ovRefunded[0]) === num(ovBase[0])
    && num(ovRefunded[1]) === num(ovSpent[1]),
    { base: ovBase, spent: ovSpent, refunded: ovRefunded }]);

  // 明细里必须显示成「+¥100.00」加退款标签。
  // 曾经会渲染成「+-100.00」这种双重负号 —— 符号来自 type，数字来自 amount，
  // 两边各自带了负号，拼起来就废了。
  await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'list').click()`);
  await sleep(400);
  const refundRows = JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('.txn-amount.amount-refund')].map((a) => ({
      amount: a.textContent.trim(), cls: a.className,
      tag: ((a.closest('.txn').querySelector('.txn-tag') || {}).textContent || ''),
    }))
  )`));
  // 此刻应有两条退款：手记的 100 和前面从微信账单导进来的 20 —— 两条路径都得显示对
  results.push(['退款·明细显示加号与标签',
    refundRows.length === 2
    && refundRows.some((r) => r.amount === '+100.00' && r.tag === '退款' && r.cls.includes('amount-refund'))
    && refundRows.some((r) => r.amount === '+20.00' && r.tag === '退款'),
    refundRows]);

  // 备份往返：负金额必须原样回来。
  // 这条专门冲着 sanitizeImport 里曾经写着的 Math.max(0, ...) 去 ——
  // 它把退款静默清零，备份、换手机、恢复之后退款全变 0 元，且不报任何错。
  await evalJs(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ledger-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const get = (s) => new Promise((res, rej) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const cats = await get('categories'), accts = await get('accounts'), txns = await get('transactions');
    db.close();
    const payload = { app: '记账本', version: 1, categories: cats, accounts: accts, transactions: txns };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' }));
    const inp = document.querySelector('#import-json-input');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(700);
  await evalJs(`document.querySelector('#modal-foot .danger-btn').click()`);
  await sleep(1100);
  const restored = JSON.parse(await evalJs(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ledger-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const txns = await new Promise((res, rej) => { const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    db.close();
    const neg = txns.filter((t) => t.amount < 0);
    return JSON.stringify({
      total: txns.length, negative: neg.length,
      amounts: neg.map((t) => t.amount).sort((a, b) => a - b),
      zeroed: txns.filter((t) => t.amount === 0).length,
    });
  })()`));
  // negative 为 2、zeroed 为 0：两笔退款（手记 -100、导入 -20）都得活着回来。
  // 若 Math.max(0,...) 还在，这里会变成 negative:0 / zeroed:2 —— 正好被抓住。
  results.push(['退款·备份往返不清零负金额',
    restored.negative === 2 && restored.zeroed === 0
    && [-10000, -2000].every((v) => restored.amounts.includes(v)), restored]);

  // ============ Service Worker / 离线 ============
  // 这两项必须放最后：断网用例会导航重载页面，前面用过的一切页内状态都会没。
  //
  // 加这两条是因为 sw.js 曾经从未被注册 —— 「离线可用」只写在 README 里，
  // 代码里一行都没兑现，断网直接 ERR_INTERNET_DISCONNECTED，而 24 项测试
  // 一个都没拦。文件存在不等于能力存在，所以断言要钉住三件不同的事。

  // 24. 注册了、接管了、缓存里有东西。
  //     这三者缺一不可：注册成功 ≠ controller 存在（可能还没激活），
  //     controller 存在 ≠ 缓存非空（addAll 是全或无，任一资源 404 就整批失败）。
  const swInfo = await evalJs(`(async () => {
    if (!('serviceWorker' in navigator)) return { api: false };
    const regs = await navigator.serviceWorker.getRegistrations();
    let ready = false;
    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 15000)),
      ]);
      ready = true;
    } catch (e) { /* ready 一直没来，下面按 ready:false 报出去 */ }
    const names = await caches.keys();
    let urls = [];
    for (const n of names) {
      // 注意别写成 urls.concat(caches.open(n).keys().then(...))：
      // concat 不 await Promise，塞进去的是 Promise 对象本身，
      // 后面 u.endsWith 就会炸成 "not a function"，而返回值看起来只是个空对象。
      const keys = await (await caches.open(n)).keys();
      urls = urls.concat(keys.map((k) => k.url));
    }
    return {
      api: true, regs: regs.length, controller: !!navigator.serviceWorker.controller, ready,
      cacheNames: names, cacheCount: urls.length,
      hasApp: urls.some((u) => u.endsWith('/js/app.js')),
      hasBill: urls.some((u) => u.endsWith('/js/bill.js')),
      hasRoot: urls.some((u) => u.endsWith('/ledger/') || u.endsWith('index.html')),
    };
  })()`);
  results.push(['离线·SW 注册并接管',
    !!swInfo && swInfo.api && swInfo.regs >= 1 && swInfo.controller && swInfo.ready
    && swInfo.cacheCount > 0 && swInfo.hasApp && swInfo.hasBill && swInfo.hasRoot, swInfo]);

  // 25. 真·断网重载。
  //     必须先 clearBrowserCache：Chrome 的普通 HTTP 缓存会把页面顶上来，
  //     测出来是「能打开」，但那是假阳性，跟 Service Worker 毫无关系。
  //     第一次做这个探测时我就被它骗过一次 —— 清干净才露出恐龙页。
  await send('Network.clearBrowserCache');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send('Page.navigate', { url: URL });
  await sleep(4500);
  const offView = await evalJs(`document.querySelector('#view') ? document.querySelector('#view').innerHTML.length : 0`);
  const offTabs = await evalJs(`document.querySelectorAll('#tabbar .tab').length`);
  const offText = await evalJs(`document.body ? document.body.innerText.slice(0, 60) : ''`);
  results.push(['离线·断网仍可打开', offView > 100 && offTabs === 4,
    { viewLen: offView, tabs: offTabs, text: String(offText).slice(0, 60) }]);

  console.log('EXCEPTIONS:', exceptions.length ? JSON.stringify(exceptions, null, 2) : 'none');
  let ok = true;
  for (const [name, pass, detail] of results) {
    ok = ok && pass;
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail));
  }
  console.log(ok ? '\n✅ 全部通过' : '\n❌ 存在失败项');
  ws.close();
  process.exitCode = ok ? 0 : 1;
}

main()
  .then(() => { chrome.kill(); })
  .catch((e) => { console.error('SMOKE FAIL:', e); chrome.kill(); process.exit(1); });
