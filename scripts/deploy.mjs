// 通过 GitHub Git Data API 推送（走可达的 api.github.com，绕过常被阻断的 github.com git 端点）
// 作为 `git push` 的兜底：把当前 HEAD 的提交内容镜像成一个提交推到远端分支
// 用法：node scripts/deploy.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'FCYZJBN';
const REPO = 'ledger';
const BRANCH = 'main';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '__pycache__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
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
  const files = walk(ROOT);
  console.log('本地文件数:', files.length);

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

  // 提示：本地与远端提交 sha 不同（内容一致），需把本地分支对齐到远端
  console.log(`\n本地分支对齐命令：\ngit update-ref refs/heads/${BRANCH} ${commitRes.sha}`);
}

main();
