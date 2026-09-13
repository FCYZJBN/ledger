// 通过 GitHub Git Data API 推送本地文件（绕过被墙的 github.com git 端点，走可达的 api.github.com）
// 用法：node scripts/deploy.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const OWNER = 'FCYZJBN';
const REPO = 'ledger';
const ROOT = 'C:/Users/FCYZJBN/Desktop/记账软件';
const COMMIT_MSG = '初始版本：本地记账 PWA（收支/分类/预算/统计/导入导出）\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
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

async function main() {
  // 预检：确认仓库为空
  try {
    const branches = gh([`repos/${OWNER}/${REPO}/branches`]);
    console.log('existing branches:', branches.map((b) => b.name));
    console.log('⚠ 仓库非空，中止（避免覆盖）');
    return;
  } catch { console.log('空仓库，开始上传'); }

  const files = walk(ROOT);
  console.log('files:', files.length);

  // 1. 每个文件建 blob
  const tree = [];
  for (const f of files) {
    const path = relative(ROOT, f).split(sep).join('/');
    const content = readFileSync(f).toString('base64');
    const res = gh([`repos/${OWNER}/${REPO}/git/blobs`, '-X', 'POST'], { content, encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: res.sha });
    console.log('blob   ', path);
  }

  // 2. 建 tree
  const treeRes = gh([`repos/${OWNER}/${REPO}/git/trees`, '-X', 'POST'], { tree });
  console.log('tree   ', treeRes.sha);

  // 3. 建 commit
  const commitRes = gh([`repos/${OWNER}/${REPO}/git/commits`, '-X', 'POST'], { message: COMMIT_MSG, tree: treeRes.sha });
  console.log('commit ', commitRes.sha);

  // 4. 建 main 分支
  const refRes = gh([`repos/${OWNER}/${REPO}/git/refs`, '-X', 'POST'], { ref: 'refs/heads/main', sha: commitRes.sha });
  console.log('ref    ', refRes.ref);
  console.log('✅ 部署完成');
}

main().catch((e) => { console.error('部署失败:', e.message); process.exit(1); });
