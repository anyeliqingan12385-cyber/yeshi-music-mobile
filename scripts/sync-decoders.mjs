/* 把桌面端 core 的纯 JS 解密/歌词核心重新同步到 src/core/decoders/。
 *
 * 为什么需要它：为了让 mobile 仓库自包含（能独立 CI 出包），解密核心是 vendor 进来的副本。
 * vendor 的代价就是「可能与上游不同步」——本脚本是解药：桌面端算法更新后跑一次即可。
 *
 * 桌面端 core 不存在时（CI、换了机器、只 clone 了 mobile 仓库）安全跳过，不报错——
 * 因为 mobile 仓库本身就是自包含的，不需要外部 core 也能构建。
 *
 * 用法：
 *   npm run sync-decoders
 *   node scripts/sync-decoders.mjs [可选: 桌面端 core 目录路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DEST = path.join(repoRoot, 'src', 'core', 'decoders');
const FILES = [
  'ncmdecrypt.js',
  'qqdecrypt.js',
  'metadata_browser.js',
  'aes128_ecb.js',
  'lyricengine.js',
  'lyrics.js',
];

const src = process.argv[2] || process.env.YESHI_DESKTOP_CORE || path.resolve(repoRoot, '..', 'core');

if (!fs.existsSync(src)) {
  console.log('[sync-decoders] 未找到桌面端 core，安全跳过：' + src);
  console.log('[sync-decoders] 这是正常的：mobile 仓库已自包含，CI/其它机器无需同步。');
  process.exit(0);
}

if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const from = path.join(src, f);
  if (!fs.existsSync(from)) {
    console.warn('[sync-decoders] 跳过（源缺失）: ' + f);
    continue;
  }
  fs.copyFileSync(from, path.join(DEST, f));
  copied++;
}

console.log('[sync-decoders] 已同步 ' + copied + '/' + FILES.length + ' 个核心文件 → ' + path.relative(repoRoot, DEST));
console.log('[sync-decoders] 下一步：跑 `npm run selfcheck`（会自动校验自包含与闭环），通过后提交。');
