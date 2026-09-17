// 端到端冒烟测试：启动无头 Chrome + CDP，验证「渲染 → 记一笔 → 统计图表」全链路
import { spawn } from 'node:child_process';

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
    const inp = document.querySelector('input[type=file]');
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
