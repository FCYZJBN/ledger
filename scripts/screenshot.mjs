// 生成 README 用截图：起移动端无头 Chrome，注入示例流水，截首页/记一笔/明细/统计
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:8001/';
const PORT = 9335;
const PROFILE = 'C:/Users/FCYZJBN/AppData/Local/Temp/ledger-shot-' + Date.now();
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  URL,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('no CDP target');
}

const injectJs = `
(async () => {
  const d = (offset) => {
    const t = new Date();
    t.setDate(t.getDate() - offset);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  };
  const now = Date.now();
  const T = (id, type, amount, categoryId, accountId, date, note) =>
    ({ id, type, amount, categoryId, accountId, date, note, createdAt: now, updatedAt: now });
  const txns = [
    T('s1', 'expense', 3200, 'c-food-lunch', 'acct-wechat', d(0), '工作日午餐'),
    T('s2', 'expense', 600, 'c-transport-metro', 'acct-alipay', d(0), ''),
    T('s3', 'expense', 1550, 'c-food-milktea', 'acct-wechat', d(0), '下午茶'),
    T('s4', 'expense', 6800, 'c-fun-game', 'acct-wechat', d(0), '新皮肤'),
    T('s5', 'expense', 2380, 'c-transport-taxi', 'acct-wechat', d(1), '加班打车'),
    T('s6', 'expense', 8990, 'c-shopping-daily', 'acct-alipay', d(1), '超市采购'),
    T('s7', 'expense', 4500, 'c-fun-movie', 'acct-alipay', d(1), '电影票'),
    T('s8', 'expense', 2800, 'c-food-lunch', 'acct-cash', d(2), ''),
    T('s9', 'expense', 1250, 'c-food-snacks', 'acct-wechat', d(2), '零食'),
    T('s10', 'expense', 15630, 'c-home-utility', 'acct-alipay', d(5), '水电费'),
    T('s11', 'expense', 19900, 'c-shopping-clothes', 'acct-alipay', d(5), '换季衣服'),
    T('s12', 'expense', 250000, 'c-home-rent', 'acct-bank', d(10), '房租'),
    T('s13', 'income', 1200000, 'c-income-salary-month', 'acct-bank', d(10), '工资'),
    T('s14', 'income', 20000, 'p-income-redpacket', 'acct-wechat', d(2), '红包'),
    T('s15', 'expense', 250000, 'c-home-rent', 'acct-bank', d(35), '房租'),
    T('s16', 'income', 1200000, 'c-income-salary-month', 'acct-bank', d(35), '工资'),
    T('s17', 'expense', 3200, 'c-food-lunch', 'acct-wechat', d(33), ''),
  ];
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('ledger-db', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction(['transactions', 'settings'], 'readwrite');
    const ts = tx.objectStore('transactions');
    ts.clear();
    txns.forEach((t) => ts.put(t));
    tx.objectStore('settings').put({ key: 'monthlyBudget', value: 300000 });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
  db.close();
  return 'injected ' + txns.length;
})()
`;

async function main() {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('截图', name);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  await sleep(2500);

  // 注入示例数据并刷新
  await evalJs(injectJs);
  await send('Page.reload');
  await sleep(2600);

  // 首页
  await shot('01-home');

  // 记一笔
  await evalJs(`document.querySelector('#fab').click()`);
  await sleep(500);
  await shot('02-record');
  await evalJs(`document.querySelector('#sheet-backdrop').click()`);
  await sleep(300);

  // 明细
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'list').click()`);
  await sleep(500);
  await shot('03-list');

  // 统计
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.dataset.tab === 'stats').click()`);
  await sleep(1200);
  await shot('04-stats');

  console.log('✅ 截图完成 ->', OUT);
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error('SHOT FAIL:', e); chrome.kill(); process.exit(1); });
