// 账单解析：微信 xlsx + 支付宝 CSV
//
// 全程纯函数、零网络请求 —— 账单内容绝不离开本机。
// 这里不做任何 fetch / XHR / 上报，输入是用户选的文件，输出是内存里的记录。

// ================= 通用工具 =================

const pad2 = (n) => String(n).padStart(2, '0');

function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 两份账单都用 "/" 表示空值，另有实测存在的字段尾随 TAB
function cleanCell(v) {
  const s = String(v == null ? '' : v).replace(/^﻿/, '').trim();
  return s === '/' ? '' : s;
}

const colToIndex = (letters) => {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
};

// ================= 金额 =================

// 账单金额 → 整数分。解析失败返回 null（不静默返回 0，否则会把坏行记成 0 元）。
// 不复用 util.parseAmount：它会剥掉负号，且对多小数点会静默截断。
export function billAmountToCents(raw) {
  if (raw == null) return null;
  let s = String(raw).trim()
    .replace(/[¥￥,，\s ]/g, '')
    .replace(/元$/, '');
  if (!s) return null;
  const neg = /^[-−—]/.test(s);          // 兼容 Unicode 减号
  s = s.replace(/^[-−—+]/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;   // 严格：拒 1.2.3 / 空 / 字母
  const [int, frac = ''] = s.split('.');
  const cents = Number(int) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

// ================= 日期 =================

// Excel 序列号 → YYYY-MM-DD。全程用 UTC，避免本地时区把日期挪一天。
function xlsxSerialToDate(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(num) * 86400000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function normalizeDate(s) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(s).trim());
  if (!m) return null;
  return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
}

// ================= CSV =================

// 手写状态机：引号内可含逗号与换行（Excel 另存为 CSV 时金额会写成 "¥1,234.50"）
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r' || c === '\n') {
      // \r\n 当作一个换行；单独的 \r 或 \n 也当换行
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ================= xlsx（最小读取器）=================

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 xlsx，请更新浏览器后重试');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 只取中央目录，按名字拿需要的两个 XML，不解全部条目
function readZipEntries(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（找不到 zip 结构）');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { u8, dv, entries };
}

async function readZipFile(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  // 本地头的 extra 长度可能与中央目录不同，必须从本地头重新读
  const lo = e.localOff;
  if (zip.dv.getUint32(lo, true) !== 0x04034b50) throw new Error('xlsx 内部结构损坏');
  const nameLen = zip.dv.getUint16(lo + 26, true);
  const extraLen = zip.dv.getUint16(lo + 28, true);
  const start = lo + 30 + nameLen + extraLen;
  const raw = zip.u8.subarray(start, start + e.compSize);
  if (e.method === 0) return new TextDecoder('utf-8').decode(raw);
  if (e.method === 8) return new TextDecoder('utf-8').decode(await inflateRaw(raw));
  throw new Error('xlsx 使用了不支持的压缩方式：' + e.method);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // 富文本会被拆成多个 <t>，必须拼接
    let s = '';
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
    out.push(unescapeXml(s));
  }
  return out;
}

function parseSheet(xml, strings) {
  const rows = [];
  for (const rm of xml.matchAll(/<row([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = rm[2] || '';
    const cells = [];
    for (const cm of body.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      const type = /t="(\w+)"/.exec(attrs);
      let val = '';
      if (type && type[1] === 'inlineStr') {
        for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) val += t[1];
        val = unescapeXml(val);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = v ? v[1] : '';
        if (type && type[1] === 's' && val !== '') val = strings[Number(val)] ?? '';
        else val = unescapeXml(val);
      }
      if (ref) cells[colToIndex(ref[1])] = val;
    }
    // 空洞行（整个 <row> 缺失）会让数组下标与真实行号错位，
    // 这里补成连续数组，行号信息由调用方按需忽略。
    const width = cells.length;
    const line = [];
    for (let i = 0; i < width; i++) line.push(cells[i] == null ? '' : cells[i]);
    rows.push(line);
  }
  return rows;
}

export async function readXlsx(buf) {
  const zip = readZipEntries(buf);
  const sheetName = [...zip.entries.keys()].find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetName) throw new Error('xlsx 里找不到工作表');
  const [sheetXml, ssXml] = await Promise.all([
    readZipFile(zip, sheetName),
    readZipFile(zip, 'xl/sharedStrings.xml'),
  ]);
  return parseSheet(sheetXml, parseSharedStrings(ssXml));
}

// ================= 编码自适应 =================

// 微信 xlsx 内部是 UTF-8；支付宝手机端导出的是 GBK。
// 用 fatal 模式试 UTF-8：GBK 字节在严格模式下会抛，宽松模式只会静默产出大量替换字符。
export function decodeBillText(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch { /* 落到 GBK */ }
  try {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' };
  } catch {
    throw new Error('无法识别文件编码，请确认导出的是微信或支付宝的原始账单文件');
  }
}

// ================= 表头定位与列映射 =================

const COLUMN_ALIASES = {
  date:     ['交易时间', '交易创建时间'],
  type:     ['收/支', '收支'],
  amount:   ['金额(元)', '金额（元）', '金额'],
  party:    ['交易对方'],
  product:  ['商品', '商品说明', '商品名称'],
  status:   ['当前状态', '交易状态'],
  orderNo:  ['交易单号', '交易订单号', '交易号'],
  payWay:   ['支付方式', '收/付款方式', '付款方式'],
  category: ['交易分类'],   // 支付宝独有
  txnType:  ['交易类型'],   // 微信独有
  note:     ['备注'],
};

// 选「命中已知列名最多」的一行，而不是「含某关键词」的一行 ——
// 支付宝第 5 行「导出交易类型：[全部]」含「交易类型」，只按关键词会误命中。
function findHeader(rows) {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const clean = row.map((c) => cleanCell(c));
    const map = {};
    let hits = 0;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      const idx = clean.findIndex((c) => aliases.includes(c));
      if (idx >= 0) { map[field] = idx; hits++; }
    }
    if (map.date == null || map.amount == null || map.type == null) continue;
    if (i >= rows.length - 1) continue;              // 后面必须还有数据行
    if (!best || hits > best.hits) best = { idx: i, map, hits, header: clean };
  }
  return best;
}

function detectSource(map) {
  if (map.category != null || map.payWay === undefined) {
    if (map.txnType != null) return 'wechat';
  }
  if (map.txnType != null && map.category == null) return 'wechat';
  if (map.category != null) return 'alipay';
  return 'unknown';
}

// ================= 汇总对账 =================

// 两份账单顶部都自带权威汇总，用它给自己做硬校验 —— 零成本兜住所有解析 bug
function readSummary(rows, headerIdx) {
  const out = { total: null, income: null, expense: null, neutral: null };
  const num = (s) => (s == null ? null : Math.round(parseFloat(s) * 100));
  for (let i = 0; i < headerIdx; i++) {
    const line = (rows[i] || []).map(cleanCell).join(' ');
    let m;
    if ((m = /共\s*(\d+)\s*笔记录/.exec(line))) out.total = Number(m[1]);
    if ((m = /收入[：:]\s*(\d+)\s*笔\s*([\d.]+)\s*元/.exec(line))) out.income = { count: Number(m[1]), cents: num(m[2]) };
    if ((m = /支出[：:]\s*(\d+)\s*笔\s*([\d.]+)\s*元/.exec(line))) out.expense = { count: Number(m[1]), cents: num(m[2]) };
    // 微信叫「中性交易」，支付宝叫「不计收支」
    if ((m = /(?:中性交易|不计收支)[：:]\s*(\d+)\s*笔\s*([\d.]+)\s*元/.exec(line))) out.neutral = { count: Number(m[1]), cents: num(m[2]) };
  }
  return out;
}

// ================= 解析主流程 =================

const TRANSFER_TXN_TYPES = ['转账', '微信红包', '微信红包（单发）'];

export function parseBill(rows) {
  const head = findHeader(rows);
  if (!head) {
    throw new Error('认不出这份账单的表头，请确认导出的是微信或支付宝的原始账单文件');
  }
  const source = detectSource(head.map);
  const records = [];
  const skipped = [];

  for (let i = head.idx + 1; i < rows.length; i++) {
    const raw = rows[i] || [];
    const cells = [];
    for (let k = 0; k < raw.length; k++) cells[k] = cleanCell(raw[k]);
    const get = (f) => (head.map[f] == null ? '' : (cells[head.map[f]] || ''));

    if (!cells.some((c) => c !== '')) continue;          // 整行空

    const dateRaw = get('date');
    const date = source === 'wechat' && /^\d+(\.\d+)?$/.test(dateRaw)
      ? xlsxSerialToDate(dateRaw)
      : normalizeDate(dateRaw);

    const typeRaw = get('type');
    const orderNo = get('orderNo');

    if (typeRaw !== '收入' && typeRaw !== '支出') {
      skipped.push({ date, raw: typeRaw || '(空)', reason: '不计收支' });
      continue;
    }
    if (!date) { skipped.push({ date: dateRaw, raw: dateRaw, reason: '日期无法识别' }); continue; }

    const amountCents = billAmountToCents(get('amount'));
    if (amountCents == null || amountCents === 0) {
      skipped.push({ date, raw: get('amount'), reason: '金额无法识别' });
      continue;
    }

    const status = get('status');
    const txnType = get('txnType');
    const alipayCat = get('category');
    // 两种「转账」性质不同，默认勾选状态也不同，必须分开标：
    //   internal = 自己账户之间挪钱（支付宝小荷包自动攒），既不是收入也不是支出 → 默认不勾
    //   p2p      = 与人之间的往来（微信转账/红包），钱确实动了 → 默认勾但打标记
    const tags = [];
    if (/退款/.test(status) || /退款/.test(txnType)) tags.push('refund');
    if (source === 'alipay' && alipayCat === '账户存取') tags.push('internal');
    if (source === 'wechat' && TRANSFER_TXN_TYPES.includes(txnType)) tags.push('p2p');

    const party = get('party');
    const product = get('product');
    records.push({
      source,
      date,
      type: typeRaw === '收入' ? 'income' : 'expense',
      amountCents,
      party,
      product,
      status,
      txnType,
      alipayCat,
      payWay: get('payWay'),
      note: get('note'),
      orderNo,
      billNo: orderNo ? `${source === 'wechat' ? 'wx' : 'ali'}:${orderNo}` : '',
      tags,
    });
  }

  // 汇总对账
  const summary = readSummary(rows, head.idx);
  const calc = {
    income: { count: 0, cents: 0 },
    expense: { count: 0, cents: 0 },
  };
  records.forEach((r) => {
    const b = r.type === 'income' ? calc.income : calc.expense;
    b.count++; b.cents += r.amountCents;
  });
  const neutralCount = skipped.filter((s) => s.reason === '不计收支').length;

  const diffs = [];
  if (summary.total != null && summary.total !== records.length + neutralCount) {
    diffs.push(`总条数：账单声明 ${summary.total}，实际解析 ${records.length + neutralCount}`);
  }
  for (const key of ['income', 'expense']) {
    const s = summary[key];
    if (s && (s.count !== calc[key].count || s.cents !== calc[key].cents)) {
      diffs.push(`${key === 'income' ? '收入' : '支出'}：账单声明 ${s.count}笔 ${(s.cents / 100).toFixed(2)}元，`
        + `实际解析 ${calc[key].count}笔 ${(calc[key].cents / 100).toFixed(2)}元`);
    }
  }
  if (summary.neutral && summary.neutral.count !== neutralCount) {
    diffs.push(`不计收支：账单声明 ${summary.neutral.count}笔，实际解析 ${neutralCount}笔`);
  }

  return {
    source,
    header: head.header,
    records,
    skipped,
    summary,
    calc,
    // 有声明数字才算「可对账」；对不上就不许入库
    checked: summary.total != null || summary.income != null,
    diffs,
    ok: diffs.length === 0,
  };
}

// ================= 自动归类 =================

// 支付宝自带的分类比关键词猜准得多，直接映射
const ALIPAY_CAT_MAP = {
  '餐饮美食': 'p-food',
  '交通出行': 'p-transport',
  '日用百货': 'p-shopping',
  '服饰装扮': 'p-shopping',
  '文化休闲': 'p-fun',
  '运动户外': 'p-fun',
  '教育培训': 'p-study',
  '公共服务': 'p-home',
  '住房物业': 'p-home',
  '医疗健康': 'p-health',
  '人情往来': 'p-social',
};

// 微信没有分类列，用关键词打底。顺序即优先级，先命中先赢 ——
// 不按关键词长度自动排序：那种隐式规则改动一条会影响其它条，没法推理。
//
// 这些是**通用**中文商户词，不是从某个月账单里抄来的店名：
// 真实账单里大量记录是「扫二维码付款给个人」，店名是人名，关键词无从下手，
// 那部分本来就该靠用户确认一次后写进 merchantRules 学出来。
const MERCHANT_RULES = [
  // 餐饮：先把吃的排在最前，避免「水果店」被购物分支的「苹果」之类抢走
  [['美团', '饿了么', '肯德基', '麦当劳', '星巴克', '瑞幸', 'luckin', '蜜雪', '古茗', '茶百道', '赵一鸣', '沙县', '兰州拉面', '面馆', '餐厅', '餐饮', '食堂', '烧烤', '火锅', '奶茶', '早餐', '早点', '食府', '饭店', '酒楼', '小吃', '糖水', '水果', '果派', '烤梨', '扣肉饼', '烤肉', '炸', '汉堡', '披萨', '料理', '私房菜', '大排档', '快餐', '蛋糕', '烘焙', '面包', '酸奶', '零食', '食品', '烟酒', '便利店',
   // 商品名兜底（自动售货机、无人货架这类商户名无信息的场景）
   '农夫山泉', '可口可乐', '雪碧', '百事', '康师傅', '统一', '娃哈哈', '元气森林',
   '矿泉水', '饮料', '泡面', '拉面', '薯片', '巧克力', '口香糖'], 'p-food'],
  [['滴滴', '高德', '曹操', '地铁', '公交', '铁路', '12306', '航空', '机票', '加油', '停车', '高速', '打车', '单车', '哈啰', '出行', '车费', '的士'], 'p-transport'],
  [['教育', '考试', '培训', '书店', '图书', '学费', '课程', '驾校', '学校', '学院', '大学', '学堂', 'deepseek', 'openai', 'api服务', '论文', '知网'], 'p-study'],
  [['医院', '药房', '药店', '诊所', '体检', '挂号', '医疗', '口腔', '牙科'], 'p-health'],
  [['水费', '电费', '燃气', '物业', '房租', '租金', '供暖', '广电', '宽带', '中国移动', '中国联通', '中国电信', '话费', '洗衣', '干洗', '洗涤'], 'p-home'],
  [['电影', '影城', '万达', '猫眼', '淘票票', '游戏', '电竞', '腾讯视频', '爱奇艺', '优酷', '网易云', 'QQ音乐', 'KTV', '剧本', '密室', '网吧', '景点', '门票', '旅行', '酒店', '房费'], 'p-fun'],
  [['淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '盒马', '永辉', '超市', '罗森', '全家', '沃尔玛', '小米', '华为', '苹果', '数码', '商行', '贸易', '百货', '文具', '南杂', '副食', '驿站', '快递', '菜鸟', '美发', '理发', '美容', '养发', '服饰', '鞋', '母婴'], 'p-shopping'],
  [['红包', '转账', '礼金', '鲜花', '礼品', '随礼'], 'p-social'],
];

export function suggestCategory(record, learned = {}) {
  if (record.type === 'income') {
    if (/红包/.test(record.txnType || '')) return 'p-income-redpacket';
    if (/退款/.test(record.status || '')) return 'p-income-other';
    if (/工资|薪/.test(record.party || '')) return 'p-income-salary';
    return 'p-income-other';
  }
  const merchant = (record.party || '').trim();
  if (merchant && learned[merchant]) return learned[merchant];

  if (record.alipayCat && ALIPAY_CAT_MAP[record.alipayCat]) return ALIPAY_CAT_MAP[record.alipayCat];

  // 两轮匹配：先只看商户名，再只看商品名。
  // 合并成一个字符串会让商品名里的词抢走商户名的判断 ——
  // 「永辉超市」买瓶农夫山泉，合并匹配会命中商品里的「农夫山泉」归成餐饮，
  // 分轮之后超市仍归购物，而自动售货机（商户无规则）才由商品兜底归餐饮。
  const party = (record.party || '').toLowerCase();
  const product = (record.product || '').toLowerCase();
  for (const field of [party, product]) {
    if (!field) continue;
    for (const [keywords, cat] of MERCHANT_RULES) {
      if (keywords.some((k) => field.includes(k.toLowerCase()))) return cat;
    }
  }
  return 'p-other';
}

// ================= 去重 =================

// 精确层：账单交易单号（带来源前缀，两套单号都是纯数字，避免跨平台撞号）
// 模糊层：同日同金额同方向，且那条是手记的（没有 billNo）
//
// 模糊层必须做「组内配额对账」：实测两份账单里都存在真实的同日同金额独立交易，
// 朴素匹配会把它们全部误标。手记记录只能抵消同样数量的账单行。
export function markDuplicates(records, existingTxns = []) {
  const seenBillNo = new Set();
  const manual = new Map();
  existingTxns.forEach((t) => {
    if (t.billNo) { seenBillNo.add(t.billNo); return; }
    const k = `${t.date}|${t.amount}|${t.type}`;
    manual.set(k, (manual.get(k) || 0) + 1);
  });

  const seenKey = new Map();
  records.forEach((r) => {
    r.alreadyImported = !!r.billNo && seenBillNo.has(r.billNo);
    const k = `${r.date}|${r.amountCents}|${r.type}`;
    const n = seenKey.get(k) || 0;
    seenKey.set(k, n + 1);
    r.suspectDup = !r.alreadyImported && n < (manual.get(k) || 0);
  });
  return records;
}

// ================= 统一入口 =================

export async function readBillFile(file) {
  const buf = await file.arrayBuffer();
  const name = (file.name || '').toLowerCase();
  let rows;
  let encoding = 'utf-8';
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    rows = await readXlsx(buf);
  } else {
    const dec = decodeBillText(buf);
    encoding = dec.encoding;
    rows = parseCsv(dec.text);
  }
  const parsed = parseBill(rows);
  parsed.encoding = encoding;
  return parsed;
}

// 记录 → 一条待入库的交易（categoryId / accountId 由 UI 决定）
export function toTxn(record, { categoryId, accountId, batchId }) {
  const note = [record.party, record.product].filter(Boolean).join(' · ');
  return {
    id: null,                     // 由调用方补 uid
    type: record.type,
    amount: record.amountCents,
    categoryId,
    accountId,
    date: record.date,
    note: note.slice(0, 200),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    billNo: record.billNo,
    importBatch: batchId,
  };
}
