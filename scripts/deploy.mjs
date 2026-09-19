// 通过 GitHub Git Data API 推送（走可达的 api.github.com，绕过常被阻断的 github.com git 端点）
// 作为 `git push` 的兜底：把当前 HEAD 的提交内容镜像成一个提交推到远端分支
// 用法：node scripts/deploy.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'FCYZJBN';
const REPO = 'ledger';
const BRANCH = 'main';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 绝不外发的路径：真实账单、本地财务数据、私密目录。
// 本仓库是公开仓库，命中即等于把姓名、手机号与全部消费记录公开。
const FORBIDDEN = [
  /账单/, /交易明细/, /流水/, /微信支付/, /支付宝/,
  /\.xlsx$/i, /\.xls$/i, /\.csv$/i,
  /(^|\/)private\//, /(^|\/)testdata-local\//,
];

// 用 git 自己的清单，而不是遍历目录。
//
// 这里曾经是 readdirSync 递归收集，只跳过 .git/node_modules —— 它不读 .gitignore，
// 于是「本地目录即仓库内容」这个设计会把工作目录里的真实账单一起镜像到公开仓库。
// `git ls-files --cached --others --exclude-standard` 给出的正好是
// 「此刻 git add -A 会提交的文件」，.gitignore 的排除天然生效。
// 兜底推送与 git push 的产物因此保持一致，而不是多出一堆不该外发的文件。
function listFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return out.split('\0').filter(Boolean)
    .map((p) => join(ROOT, p.split('/').join(sep)))
    .filter((f) => existsSync(f)); // 已删但仍被跟踪的文件交给远端的全量 tree 体现
}

function gh(args, body) {
  const a = ['api', ...args];
  const opts = { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 };
  if (body !== undefined) { a.push('--input', '-'); opts.input = JSON.stringify(body); }
  const out = execFileSync('gh', a, opts);
  return out ? JSON.parse(out) : null;
}

function main() {
  // 复用本地 HEAD 的提交信息，保证镜像提交与本地一致
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const files = listFiles();
  console.log('待推送文件数:', files.length);

  // 硬闸门：清单里一旦出现账单类文件就直接退出，不推任何东西。
  // 上面换成 git 清单后这里理论上不会命中，但「理论上」不是能拿真实财务数据去赌的东西 ——
  // 万一 .gitignore 被改坏、或哪天有人 `git add -f` 了账单，这道闸门会在推送前拦住。
  const paths = files.map((f) => relative(ROOT, f).split(sep).join('/'));
  const bad = paths.filter((p) => FORBIDDEN.some((re) => re.test(p)));
  if (bad.length) {
    console.error('\n❌ 拒绝推送：清单里出现账单/财务类文件，本仓库是公开仓库。');
    bad.forEach((p) => console.error('   -', p));
    console.error('   请先确认它们已被 .gitignore 排除且未被跟踪（git rm --cached），再重试。');
    process.exit(1);
  }

  // 1. 每个文件建 blob（二进制走 base64）
  const tree = files.map((f) => {
    const path = relative(ROOT, f).split(sep).join('/');
    const content = readFileSync(f).toString('base64');
    const res = gh([`repos/${OWNER}/${REPO}/git/blobs`, '-X', 'POST'], { content, encoding: 'base64' });
    console.log('blob   ', path);
    return { path, mode: '100644', type: 'blob', sha: res.sha };
  });

  // 2. 取远端当前提交作为父提交
  let parent = null;
  try {
    parent = gh([`repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`]).object.sha;
    console.log('父提交:', parent);
  } catch { console.log('远端分支不存在，将新建'); }

  // 3. 全量 tree（不传 base_tree：本地目录即仓库内容，删除也会一并体现）
  const treeRes = gh([`repos/${OWNER}/${REPO}/git/trees`, '-X', 'POST'], { tree });
  console.log('tree   ', treeRes.sha);

  // 4. 建提交
  const commitBody = { message, tree: treeRes.sha };
  if (parent) commitBody.parents = [parent];
  const commitRes = gh([`repos/${OWNER}/${REPO}/git/commits`, '-X', 'POST'], commitBody);
  console.log('commit ', commitRes.sha);

  // 5. 更新/创建分支
  if (parent) {
    gh([`repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, '-X', 'PATCH'], { sha: commitRes.sha, force: false });
    console.log(`✅ 已更新 ${BRANCH}`);
  } else {
    gh([`repos/${OWNER}/${REPO}/git/refs`, '-X', 'POST'], { ref: `refs/heads/${BRANCH}`, sha: commitRes.sha });
    console.log(`✅ 已创建 ${BRANCH}`);
  }

  // 注意：提交由 GitHub 侧生成，本地没有这个对象，所以本地与远端「内容一致但 sha 不同」。
  // 等 github.com 恢复后，用下面命令把本地对齐到远端，否则后续 git push 会因非快进而被拒。
  console.log('\n⚠ 本地与远端 sha 已分叉（内容相同）。github.com 可达后执行：');
  console.log(`  git fetch origin && git reset --hard origin/${BRANCH}`);
}

main();
