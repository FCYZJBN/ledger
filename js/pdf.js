// 最小 PDF 文本提取器：从 PDF 字节里取出「带坐标的文字」。
//
// 全程纯函数、零网络请求 —— 账单内容绝不离开本机。
// 这里不做任何 fetch / XHR / 上报，输入是用户选的文件，输出是内存里的文字块。
//
// 为什么自己写而不是引 pdf.js：只为「取出文字 + 坐标」这一件事塞 1.5MB 不划算，
// 与 js/bill.js 里手写 xlsx 读取器（不引 SheetJS）是同一个取舍。
//
// 本模块**不认识任何银行业务**，只负责 PDF 层的机制。哪一列是什么、怎么成行、
// 怎么对账，全部在 js/bill.js 里 —— 换一家银行只改那边，这里不动。
//
// 支持范围（明确划出来，不支持的会报错而不是静默产出空结果）：
//   ✓ 老式 xref 与「无 xref、只有 N 0 obj 序列」的文件
//   ✓ FlateDecode（zlib 包装）
//   ✓ Type0 / Identity-H 的 CID 字体（每字 2 字节），靠 ToUnicode 映射回 Unicode
//   ✓ 简单字体（单字节码，靠 ToUnicode 或 WinAnsi 兜底）
//   ✗ 对象流（/ObjStm）与 xref 流（/XRef）—— 明确报错
//   ✗ 加密文件 —— 明确报错
//   ✗ 扫描件/纯图片 PDF —— 提取出来是空的，由调用方判定并报错

const latin1 = (u8) => {
  // 分块拼接：一次 apply 整个数组会爆栈
  let s = '';
  const CH = 8192;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return s;
};

// 解压输出的上限。gzip 炸弹是这类解析器的经典坑：几 KB 的输入能膨出几十 GB，
// 而 arrayBuffer() 是一口气拿到全部内容才返回的 —— 也就是先 OOM 再报错。
// 一边读一边数，超了立刻掐断。真实账单的一份内容流解压后只有几十 KB，
// 64MB 这个上限宽松到不可能误伤正常文件，却足以挡住畸形文件把标签页拖死。
const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

// zlib 包装的流要用 'deflate'（不是 xlsx 那边的 'deflate-raw'，两者不能混）
async function inflateZlib(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 PDF，请更新浏览器后重试');
  }
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATE_BYTES) {
      await reader.cancel();
      const err = new Error(`这份 PDF 里有一段内容解压后超过 ${MAX_INFLATE_BYTES / 1048576}MB，`
        + '不像是正常的交易明细，已停止解析。请确认导出的是银行的文字版明细 PDF');
      // 打个标记：调用处对「单个流解不开」是容错的（退化成空流继续跑别的页），
      // 但这条**不是**解不开，是主动叫停。不标记的话它会被那个 catch 吞掉，
      // 最后变成一句笼统的「没找到可识别的交易明细」—— 真正的原因就此消失。
      err.tooLarge = true;
      throw err;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ================= 对象层 =================

// 扫出所有 `N G obj … endobj`。不做 xref 表解析：实测这类账单 PDF 的对象号
// 在整个文件里各出现一次，扫比解 xref 短得多也够用。
function buildObjects(str) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(str))) {
    const num = Number(m[1]);
    if (objs.has(num)) continue; // 取首次出现：非增量更新的文件里每个号只定义一次
    const end = str.indexOf('endobj', m.index);
    const bodyStart = m.index + m[0].length;
    objs.set(num, {
      gen: Number(m[2]),
      body: str.slice(bodyStart, end < 0 ? str.length : end),
      bodyStart,   // 流数据要从这里算偏移，不能拿 obj 的起点算
    });
  }
  return objs;
}

// 从对象体里取出流数据（未解压）。返回 null 表示这个对象不是流。
function rawStream(str, obj, objs) {
  const i = obj.body.indexOf('stream');
  if (i < 0) return null;
  // `stream` 后面必须跟 CRLF 或 LF，数据从那之后开始
  let p = obj.bodyStart + i + 6;
  if (str[p] === '\r') p++;
  if (str[p] === '\n') p++;
  const dict = obj.body.slice(0, i);

  // 以流自带的 /Length 为准。靠 endstream 反推会多切一个字节 ——
  // 数据与 endstream 之间那个换行不属于流内容，多这一个字节会让 zlib
  // 报「Trailing junk found」，整个流解不开。
  let stop = -1;
  const lenRaw = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);   // 间接引用
  const lenNum = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict); // 直接数字
  if (lenRaw && objs) {
    const o = objs.get(Number(lenRaw[1]));
    const n = o && Number(o.body.trim());
    if (Number.isFinite(n)) stop = p + n;
  } else if (lenNum) {
    stop = p + Number(lenNum[1]);
  }
  const end = str.indexOf('endstream', p);
  const hardStop = end < 0 ? str.length : end;
  if (stop < 0 || stop > hardStop) {
    // 没有可靠的 /Length：退到 endstream，再把尾部换行削掉
    stop = hardStop;
    while (stop > p && (str[stop - 1] === '\n' || str[stop - 1] === '\r')) stop--;
  }
  return { start: p, end: stop, dict };
}

// 取一个对象号的字典文本（不解析流内容）
function dictOf(objs, num) {
  const o = objs.get(num);
  return o ? o.body : null;
}

// 解析 `N 0 R`；也接受直接内联的字典
function refNum(s) {
  if (!s) return null;
  const m = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

// ================= 内容流分词 =================

// 把内容流切成 token 序列。返回 {type, value} 数组。
// 只需要覆盖排版用得到的那一小撮运算符，不追求完整实现。
function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') {
      // 字面串：\ddd 八进制、转义括号与反斜杠、行末反斜杠续行
      let s = '';
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1];
          if (nx >= '0' && nx <= '7') {
            let oct = '';
            let k = i + 1;
            while (k < n && oct.length < 3 && src[k] >= '0' && src[k] <= '7') { oct += src[k]; k++; }
            s += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i = k;
            continue;
          }
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (nx === '\r' || nx === '\n') {          // 续行：吃掉换行本身
            i += nx === '\r' && src[i + 2] === '\n' ? 3 : 2;
            continue;
          }
          if (nx in map) { s += map[nx]; i += 2; continue; }
          s += nx == null ? '' : nx;
          i += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
        s += ch;
        i++;
      }
      out.push({ type: 'str', value: s });
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      let depth = 0;
      const start = i;
      while (i < n) {
        if (src[i] === '<' && src[i + 1] === '<') { depth++; i += 2; continue; }
        if (src[i] === '>' && src[i + 1] === '>') { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      out.push({ type: 'dict', value: src.slice(start, i) });
      continue;
    }
    if (c === '<') {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end < 0 ? n : end).replace(/[^0-9a-fA-F]/g, '');
      i = end < 0 ? n : end + 1;
      out.push({ type: 'str', value: hexToBytes(hex), hex: true });
      continue;
    }
    if (c === '[') { out.push({ type: 'arrStart' }); i++; continue; }
    if (c === ']') { out.push({ type: 'arrEnd' }); i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !/[\s()<>[\]{}/%]/.test(src[j])) j++;
      out.push({ type: 'name', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    // 数字 / 运算符
    let j = i;
    while (j < n && !/[\s()<>[\]{}/%]/.test(src[j])) j++;
    const tok = src.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) out.push({ type: 'num', value: Number(tok) });
    else out.push({ type: 'op', value: tok });
  }
  return out;
}

function hexToBytes(hex) {
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
}

// ================= ToUnicode CMap =================

// 解析 beginbfrange / beginbfchar。返回 Map<码, Unicode 字符串>。
// 编码是「先码 → 再查这张表」，查不到就原样保留码值（宁可显示出乱码，
// 也不要静默丢字 —— 丢了会让「对手信息」变短、配对失败，且完全看不出原因）。
function parseToUnicode(text) {
  const map = new Map();
  if (!text) return map;

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), utf16beToStr(pair[2]));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    // 形式一：<lo> <hi> <dst>
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const units = utf16beUnits(m[3]);
      // 这里原本是 `continue`（跳过坏范围），但那等于**静默丢字**：
      // 丢掉的映射会让对手信息变成原始 CID 码，而配对靠的正是对手信息完全相等 ——
      // 结果是退款悄悄挂不上、用户完全看不出原因。按本文件开头的原则，
      // 宁可明确报错，也不静默丢。hi<lo 或十六进制串超长都说明这份表坏了。
      if (hi < lo || hi - lo > 65535) {
        throw new Error('这份 PDF 的字符映射表（ToUnicode）异常，无法可靠还原文字。'
          + '请确认导出的是银行的文字版明细 PDF');
      }
      for (let k = 0; k <= hi - lo; k++) {
        const u = units.slice();
        u[u.length - 1] += k;
        map.set(lo + k, String.fromCharCode.apply(null, u));
      }
    }
    // 形式二：<lo> <hi> [<d1> <d2> …]
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)];
      items.forEach((it, k) => map.set(lo + k, utf16beToStr(it[1])));
    }
  }
  return map;
}

// UTF-16BE 十六进制串 → 码元数组
function utf16beUnits(hex) {
  const u = [];
  for (let i = 0; i < hex.length; i += 4) {
    u.push(parseInt(hex.substr(i, 4).padEnd(4, '0'), 16));
  }
  return u.length ? u : [0];
}

function utf16beToStr(hex) {
  const u = utf16beUnits(hex);
  // 分块，避免超长映射把栈压爆
  let s = '';
  const CH = 4096;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.slice(i, i + CH));
  return s;
}

// ================= 页面与字体 =================

// 收集页面对象号。优先走 /Root → /Pages → /Kids，失败则退化为扫 /Type /Page。
function collectPages(objs) {
  const roots = [];
  for (const [num, o] of objs) if (/\/Type\s*\/Catalog/.test(o.body)) roots.push(num);
  const pages = [];
  const seen = new Set();
  const walk = (num, depth) => {
    if (depth > 32 || seen.has(num)) return;
    seen.add(num);
    const dict = dictOf(objs, num);
    if (!dict) return;
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(dict);
    if (kids) {
      for (const r of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(r[1]), depth + 1);
      return;
    }
    if (/\/Type\s*\/Page\b/.test(dict)) pages.push(num);
  };
  for (const r of roots) {
    const dict = dictOf(objs, r);
    const m = dict && /\/Pages\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (m) walk(Number(m[1]), 0);
  }
  if (pages.length) return pages;

  // 退化路径：整份文件里所有声明为 /Page 的对象，按对象号排序
  const out = [];
  for (const [num, o] of objs) if (/\/Type\s*\/Page\b/.test(o.body)) out.push(num);
  return out.sort((a, b) => a - b);
}

// 页面上的字体字典文本。`/Font` 可能是间接引用，也可能是内联的 `<<…>>`，
// 实测这份农行 PDF 用的是内联 —— 只认间接引用会拿不到字体，ToUnicode 全部落空，
// 结果是「坐标全对、文字全是乱码」这种很难查的半坏状态。
function fontDictText(objs, pageDict) {
  const resRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageDict);
  let res = resRef ? dictOf(objs, Number(resRef[1])) : null;
  if (!res) res = (/\/Resources\s*(<<[\s\S]*)/.exec(pageDict) || [])[1] || '';
  const fontRef = /\/Font\s+(\d+)\s+\d+\s+R/.exec(res);
  const viaRef = fontRef ? dictOf(objs, Number(fontRef[1])) : null;
  if (viaRef) return viaRef;
  return (/\/Font\s*<<([\s\S]*?)>>/.exec(res) || [])[1] || '';
}

// 页面用到的字体对象号 —— 预解压 ToUnicode 流时要用同一套解析
function fontObjectNums(objs, pageDict) {
  const nums = [];
  for (const m of fontDictText(objs, pageDict).matchAll(/\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g)) {
    nums.push(Number(m[2]));
  }
  return nums;
}

// 页面资源里 `/F1 → CMap` 的对照表
function fontMaps(objs, pageDict) {
  const out = new Map();
  const fontDict = fontDictText(objs, pageDict);
  for (const m of fontDict.matchAll(/\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fdict = dictOf(objs, Number(m[2]));
    if (!fdict) continue;
    // CMap 流由 extractPdfItems 预解压进缓存，这里只做同步查表
    let cmap = new Map();
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fdict);
    if (tu) {
      const bytes = _streamCache.get(Number(tu[1]));
      if (bytes) cmap = parseToUnicode(latin1(bytes));
    }
    // Identity-H 判定：有 /Encoding /Identity-H 或下游字体是 CIDFontType0/2
    const cid = /\/Identity-[HV]/.test(fdict) || /\/Subtype\s*\/CIDFontType/.test(fdict);
    out.set(m[1], { cmap, cid });
  }
  return out;
}

// 已解压的流按对象号缓存。解压是异步的，字体 CMap 与内容流都走这条预取。
const _streamCache = new Map();

// ================= 主流程 =================

export async function extractPdfItems(buf) {
  // 每次解析开头清一次：这层缓存是给「同一份文件内部」多个页面共用流用的，
  // 但它是模块级的，不清就会把历次导入解压出来的内容一直攥在内存里
  // （一次导入几十 MB，导几份就下不来）。缓存的所有者只该是这一次调用。
  _streamCache.clear();
  const u8 = new Uint8Array(buf);
  if (u8.length === 0) throw new Error('这个文件是空的');

  const head = latin1(u8.subarray(0, 1024));
  if (!head.startsWith('%PDF-')) {
    throw new Error('这不是一个 PDF 文件（缺少 %PDF- 文件头）');
  }

  const str = latin1(u8);

  if (/\/Encrypt\b/.test(str)) {
    throw new Error('这份 PDF 是加密的，暂时读不了。请从银行 App 导出未加密的明细版本');
  }
  if (/\/ObjStm\b/.test(str) || /\/Type\s*\/XRef\b/.test(str)) {
    throw new Error('这份 PDF 用了对象流（较新的压缩格式），当前版本还读不了。请改用银行 App 的「下载明细」或导出 Excel/CSV');
  }

  const objs = buildObjects(str);
  if (!objs.size) throw new Error('读不出这份 PDF 的内部结构（可能是扫描件或图片版）');

  const pages = collectPages(objs);
  if (!pages.length) throw new Error('这份 PDF 里找不到页面');

  // 先把所有内容流解压出来（异步），再同步地跑排版
  const contentNums = new Set();
  for (const p of pages) {
    const dict = dictOf(objs, p) || '';
    const direct = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (direct) contentNums.add(Number(direct[1]));
    const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(dict);
    if (arr) for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentNums.add(Number(r[1]));
  }
  // 字体 CMap 流（走与 fontMaps 同一套解析，否则内联 /Font 的页面会漏掉）
  for (const p of pages) {
    const dict = dictOf(objs, p) || '';
    for (const fnum of fontObjectNums(objs, dict)) {
      const fdict = dictOf(objs, fnum) || '';
      for (const m of fdict.matchAll(/\/ToUnicode\s+(\d+)\s+\d+\s+R/g)) contentNums.add(Number(m[1]));
    }
  }

  for (const num of contentNums) {
    const o = objs.get(num);
    if (!o) continue;
    const raw = rawStream(str, o, objs);
    if (!raw) continue;
    const slice = u8.subarray(raw.start, raw.end);
    const isFlate = /\/FlateDecode/.test(raw.dict);
    try {
      _streamCache.set(num, isFlate ? await inflateZlib(slice) : slice);
    } catch (e) {
      // 解压超限是主动叫停，必须往上抛（否则会被这里吞成「没找到交易明细」）
      if (e && e.tooLarge) throw e;
      // 单个流解不开不该毁掉整份文件，交给下面「提取不到文字」的统一报错
      _streamCache.set(num, new Uint8Array(0));
    }
  }

  const items = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const dict = dictOf(objs, pages[pi]) || '';
    const fonts = fontMaps(objs, dict);

    const parts = [];
    const direct = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (direct) parts.push(Number(direct[1]));
    const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(dict);
    if (arr) for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) parts.push(Number(r[1]));

    let content = '';
    for (const num of parts) {
      const b = _streamCache.get(num);
      if (b) content += latin1(b) + '\n';
    }
    if (!content) continue;

    runContent(content, fonts, pi, items);
  }

  return items;
}

// 跑一段内容流：跟踪文本矩阵，把每个字符串连同它的 (x, y) 收进 items
function runContent(src, fonts, page, items) {
  const toks = tokenize(src);
  const st = { x: 0, y: 0, lx: 0, ly: 0, leading: 0, font: null };
  const stack = [];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'op') { stack.push(t); continue; }

    switch (t.value) {
      case 'BT':
        st.x = st.y = st.lx = st.ly = 0;
        break;
      case 'Tf': {
        const name = stack.length >= 2 ? stack[stack.length - 2] : null;
        if (name && name.type === 'name') st.font = name.value;
        break;
      }
      case 'TL': {
        const n = stack[stack.length - 1];
        if (n && n.type === 'num') st.leading = n.value;
        break;
      }
      case 'Tm': {
        if (stack.length >= 6) {
          const f = stack[stack.length - 1];
          const e = stack[stack.length - 2];
          if (e && f && e.type === 'num' && f.type === 'num') {
            st.x = e.value; st.y = f.value;
            st.lx = e.value; st.ly = f.value;
          }
        }
        break;
      }
      case 'Td':
      case 'TD': {
        const ty = stack[stack.length - 1];
        const tx = stack[stack.length - 2];
        if (tx && ty && tx.type === 'num' && ty.type === 'num') {
          st.lx += tx.value; st.ly += ty.value;
          st.x = st.lx; st.y = st.ly;
          if (t.value === 'TD') st.leading = -ty.value;
        }
        break;
      }
      case 'T*':
        st.ly -= st.leading;
        st.x = st.lx; st.y = st.ly;
        break;
      case 'Tj':
      case "'":
      case '"': {
        if (t.value !== 'Tj') { st.ly -= st.leading; st.x = st.lx; st.y = st.ly; }
        const s = stack[stack.length - 1];
        if (s && s.type === 'str') emit(s.value, s.hex);
        break;
      }
      case 'TJ': {
        // 数组元素在 stack 里；把其中的字符串按顺序拼起来。
        // 水平微调（数字）要靠字宽才算得准，这里不需要 —— 每个单元格都是
        // 各自的 Tm 绝对定位，数组内只是同一格的分段。
        let s = '';
        for (const el of stack) {
          if (el.type === 'str') s += decode(el.value, el.hex);
        }
        if (s) items.push({ page, x: st.x, y: st.y, text: s });
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }

  function decode(s, hex) {
    const f = st.font ? fonts.get(st.font) : null;
    if (!f) return s;
    // Identity-H：每 2 字节一个大端码。别的一律按单字节码处理。
    const codes = f.cid ? cidPairs(s, hex) : byteCodes(s, hex);
    let out = '';
    for (const c of codes) out += f.cmap.has(c) ? f.cmap.get(c) : String.fromCharCode(c);
    return out;
  }

  function emit(s, hex) {
    const text = decode(s, hex);
    if (text) items.push({ page, x: st.x, y: st.y, text });
  }
}

// 2 字节大端码。hex 串本身已是字节，两两成组。
function cidPairs(s, hex) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) {
    out.push((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  }
  if (s.length % 2 === 1) out.push(s.charCodeAt(s.length - 1));
  return out;
}

function byteCodes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}
