/* mobile 静态自检（对应桌面端 run_tests 的静态接线检查）
 * 直接在 Node 下 import 桌面端 core 的纯 JS 解密/歌词核心，验证手机端复用的引擎：
 *   1) API 暴露齐全（无未实现/未注册）
 *   2) QQ 解密：静态密钥对称对拍（无需真实样本文件）
 *   3) NCM 解密：按格式构造合法 .ncm → 解密还原 audio + 解析 meta（双路径共用逻辑）
 *   4) decrypt-bridge 路由（同一份 ncm 样本，验证 Web 端统一入口）
 *   5) 歌词引擎：LRC 解析 / at() 取行 / 内嵌歌词来源 / 同名 .lrc 来源（均需优先级正确）
 * 退出码 0=全绿，1=任一失败。Web UI / 原生壳的真机验证需用户在设备上跑（本机环境限制）。
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import NcmDecrypt from '../core/decoders/ncmdecrypt.js';
import QQDecrypt from '../core/decoders/qqdecrypt.js';
import { decryptFile as bridgeDecrypt } from '../core/decrypt-bridge.js';
import { createMobileLyricEngine, memoryFsx, getLyric, parse, at } from '../core/lyric-bridge.js';
import { annotateDuplicates, duplicateGroups } from '../core/identity-bridge.js';
import MetadataBrowser from '../core/decoders/metadata_browser.js';
const { analyzeBytes } = MetadataBrowser;

let ok = true;
function check(name, cond) { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) ok = false; }

// 构造一份合法 .ncm（按 decodeNcmBuffer 的逆过程）：key/box 与解码侧一致 → audio 可还原
function buildNcm({ musicName, artist, album, lyric }) {
  const CORE = Buffer.from('687A4852416D736F356B496E62617857', 'hex');
  const META = Buffer.from('2331346C6A6B5F215C5D2630553C2728', 'hex');
  const realKey = randomBytes(32);
  const keyPlain = Buffer.concat([Buffer.from('neteasecloudmusic', 'latin1'), realKey]);
  const c = createCipheriv('aes-128-ecb', CORE, null); c.setAutoPadding(true);
  const keyEnc = Buffer.concat([c.update(keyPlain), c.final()]);
  const keyData = Buffer.from(keyEnc); for (let i = 0; i < keyData.length; i++) keyData[i] ^= 0x64;

  const json = JSON.stringify({ musicName, artist, album, lyric });
  const mPlain = Buffer.concat([Buffer.from('music:', 'latin1'), Buffer.from(json, 'utf8')]);
  const c2 = createCipheriv('aes-128-ecb', META, null); c2.setAutoPadding(true);
  const mEnc = Buffer.concat([c2.update(mPlain), c2.final()]);
  const b64 = Buffer.from(mEnc.toString('base64'), 'latin1');
  const header = Buffer.alloc(22, 0);
  const metaSeg = Buffer.concat([header, b64]);
  for (let i = 0; i < metaSeg.length; i++) metaSeg[i] ^= 0x63;

  const audio = randomBytes(2048);
  const kdB = Buffer.from(keyData); for (let i = 0; i < kdB.length; i++) kdB[i] ^= 0x64;
  const kd1 = createDecipheriv('aes-128-ecb', CORE, null); kd1.setAutoPadding(false);
  let kp = Buffer.concat([kd1.update(kdB), kd1.final()]);
  { const p = kp[kp.length - 1]; if (p >= 1 && p <= 16) kp = kp.subarray(0, kp.length - p); }
  if (kp.subarray(0, 17).toString('latin1') === 'neteasecloudmusic') kp = kp.subarray(17);
  const box = new Uint8Array(256); for (let i = 0; i < 256; i++) box[i] = i;
  let cc = 0, last = 0, off = 0;
  for (let i = 0; i < 256; i++) { const sw = box[i]; cc = (sw + last + kp[off]) & 0xff; off = (off + 1) % kp.length; box[i] = box[cc]; box[cc] = sw; last = cc; }
  const audioEnc = new Uint8Array(audio.length);
  for (let i = 0; i < audio.length; i++) { const j = (i + 1) & 0xff; audioEnc[i] = audio[i] ^ box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff]; }

  const ncm = Buffer.concat([
    Buffer.from('CTENFDAM', 'latin1'), Buffer.alloc(2, 0),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(keyData.length); return b; })(), keyData,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(metaSeg.length); return b; })(), metaSeg,
    Buffer.alloc(4, 0), Buffer.alloc(5, 0),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0); return b; })(),
    Buffer.from(audioEnc)
  ]);
  return { ncm, audio };
}

// ---- 1) API 暴露 ----
check('NcmDecrypt.decodeNcmBuffer 存在', typeof NcmDecrypt.decodeNcmBuffer === 'function');
check('QQDecrypt.decryptBuffer 存在', typeof QQDecrypt.decryptBuffer === 'function');
check('QQDecrypt.isQQEncryptedExt 存在', typeof QQDecrypt.isQQEncryptedExt === 'function');
check('QQDecrypt.StaticCipher 存在', typeof QQDecrypt.StaticCipher === 'function');
check('QQDecrypt.QMC_STATIC_KEY 存在', Array.isArray(QQDecrypt.QMC_STATIC_KEY) && QQDecrypt.QMC_STATIC_KEY.length === 256);
check('QQDecrypt.isQQEncryptedExt("mflac")=true', QQDecrypt.isQQEncryptedExt('mflac') === true);
check('QQDecrypt.isQQEncryptedExt("mp3")=false', QQDecrypt.isQQEncryptedExt('mp3') === false);

// ---- 2) QQ 静态密钥对称对拍（用合法 fLaC 头，走 decryptBuffer 全路径）----
{
  const flac = Buffer.concat([Buffer.from('fLaC', 'latin1'), randomBytes(2044)]);
  const enc = new QQDecrypt.StaticCipher(QQDecrypt.QMC_STATIC_KEY).decrypt(flac, 0); // XOR 对称
  const r = QQDecrypt.decryptBuffer(enc, 'mflac'); // mflac 是 QQ 加密扩展名，映射回 flac
  check('QQ 静态密钥对称解密还原 flac', Buffer.from(r.data).equals(flac) && r.format === 'flac');
}

// ---- 3) NCM 闭环（构造合法 .ncm 再解密）----
const built = buildNcm({ musicName: '自检曲', artist: '叶宗' });
const r = NcmDecrypt.decodeNcmBuffer(built.ncm);
check('NCM 闭环 audio 还原', Buffer.from(r.audio).equals(built.audio) && r.ext === 'mp3');
check('NCM 闭环 meta 解析', !!(r.meta && r.meta.musicName === '自检曲' && r.meta.artist === '叶宗'));

// ---- 4) decrypt-bridge 路由（同一份 ncm 样本，验证 Web 端统一入口）----
const rb = await bridgeDecrypt({ name: 'song.ncm', bytes: new Uint8Array(built.ncm) });
check('decrypt-bridge ncm 路由', Buffer.from(rb.bytes).equals(built.audio) && rb.format === 'mp3' && !!(rb.meta && rb.meta.musicName === '自检曲'));

// ---- 5) 歌词引擎 ----
// 5.1 LRC 解析 + at() 取行
{
  const sample = '[ti:测试]\n[00:01.00]第一行\n[00:02.00]第二行\n[00:03.00]第三行\n';
  const p = parse(sample);
  check('lyrics.parse 解析出 3 行带时间歌词', p.lines.length === 3 && p.meta.title === '测试');
  const hit = at(p.lines, 2500); // 落在第二行（2000ms）之后、第三行（3000ms）之前
  check('lyrics.at 取到正确当前行', hit.index === 1 && hit.line.text === '第二行');
}

// 5.2 内嵌歌词来源（ncm meta.lyric）：解密后登记，歌词引擎应命中 embedded
{
  const RAW = '[ti:内嵌]\n[00:01.00]嵌入第一行\n[00:02.00]嵌入第二行\n';
  const b2 = buildNcm({ musicName: '内嵌曲', artist: '叶宗', lyric: RAW });
  const dec = await bridgeDecrypt({ name: 'emb.ncm', bytes: new Uint8Array(b2.ncm) });
  check('decrypt-bridge 透传 ncm 内嵌歌词', dec.lyric === RAW && !!(dec.meta && dec.meta.lyric === RAW));

  const eng = createMobileLyricEngine({ dir: '', fsx: memoryFsx() });
  eng.setEmbeddedLyric(dec.name, dec.lyric);
  const res = await getLyric(eng, { trackId: dec.name, path: dec.name, title: '内嵌曲', artist: '叶宗' });
  check('歌词引擎从 embedded 命中内嵌歌词', res.found && res.source === 'embedded' && res.lines.length === 2 && res.lines[0].text === '嵌入第一行');
}

// 5.3 同名 .lrc 来源优先级高于 embedded（sidecar rank 2 < embedded rank 3）
{
  const RAW_EMB = '[00:01.00]嵌入行\n';
  const RAW_SIDE = '[ti:sidecar]\n[00:01.00]同名文件行\n[00:02.00]第二行\n';
  let sidecarStore = { '/Music/song.lrc': RAW_SIDE };
  const eng = createMobileLyricEngine({
    dir: '', fsx: memoryFsx(),
    readSidecar: (p) => sidecarStore[p] || null,
  });
  eng.setEmbeddedLyric('/Music/song.ncm', RAW_EMB);
  const res = await getLyric(eng, { trackId: '/Music/song.ncm', path: '/Music/song.ncm', title: 'x', artist: 'y' });
  check('同名 .lrc 优先级高于内嵌歌词', res.found && res.source === 'sidecar' && res.lines.length === 2 && res.lines[0].text === '同名文件行');
}

// ---- 6) 浏览器版 metadata：普通/QQ 文件标签解析 + 经 decrypt-bridge 透传 ----
function buildFlacBytes() {
  const si = Buffer.alloc(4 + 34); si[0] = 0x00; si[1] = 0; si[2] = 0; si[3] = 34;
  const vendor = Buffer.from('X', 'latin1');
  const comments = ['TITLE=普通歌', 'ARTIST=歌手甲', 'ALBUM=专辑乙', 'LYRICS=普通文件歌词第一行\n第二行'];
  let body = Buffer.concat([Buffer.alloc(4), vendor, Buffer.alloc(4)]);
  body.writeUInt32LE(vendor.length, 0); body.writeUInt32LE(comments.length, 4 + vendor.length);
  for (const c of comments) { const cb = Buffer.from(c, 'utf8'); const part = Buffer.alloc(4 + cb.length); part.writeUInt32LE(cb.length, 0); cb.copy(part, 4); body = Buffer.concat([body, part]); }
  const vc = Buffer.alloc(4 + body.length); vc[0] = 0x84; vc[1] = (body.length >> 16) & 0xff; vc[2] = (body.length >> 8) & 0xff; vc[3] = body.length & 0xff; body.copy(vc, 4);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), si, vc]);
}
function id3v2Frame(id, data) { const buf = Buffer.alloc(4 + 4 + 2 + data.length); buf.write(id, 0, 'latin1'); buf.writeUInt32BE(data.length, 4); buf.writeUInt16BE(0, 8); data.copy(buf, 10); return buf; }
function buildMp3Bytes() {
  // 真实中文标签用 UTF-8（enc=3）；用 latin1 存 CJK 会丢信息（测试数据陷阱，已避开）
  const tf = (s) => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  const frames = [
    id3v2Frame('TIT2', tf('手机歌')),
    id3v2Frame('TPE1', tf('歌手丙')),
    id3v2Frame('TALB', tf('专辑丁')),
    id3v2Frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng', 'latin1'), Buffer.from([0]), Buffer.from('id3歌词第一行\n第二行', 'utf8')])),
  ];
  const tag = Buffer.concat(frames);
  const header = Buffer.alloc(10); header.write('ID3', 0, 'latin1'); header[3] = 3; header.writeUInt32BE(tag.length, 6);
  const mpeg = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat([header, tag, mpeg]);
}

// 6.1 浏览器版 metadata 直接解析普通 flac 标签 + 歌词
{
  const md = analyzeBytes(new Uint8Array(buildFlacBytes()));
  check('metadata_browser 解析 flac 标签(歌名/歌手/专辑)', !!(md && md.tags && md.tags.title === '普通歌' && md.tags.artist === '歌手甲' && md.tags.album === '专辑乙'));
  check('metadata_browser 从 Vorbis LYRICS 取歌词', !!(md && md.tags && md.tags.lyric && md.tags.lyric.includes('普通文件歌词')));
}
// 6.2 普通 mp3 经 decrypt-bridge 透传标签与歌词（QQ 加密文件走同一 analyzeBytes 路径）
{
  const dec = await bridgeDecrypt({ name: 'song.mp3', bytes: new Uint8Array(buildMp3Bytes()) });
  check('decrypt-bridge 普通 mp3 透传标签', !!(dec.meta && dec.meta.title === '手机歌' && dec.meta.artist === '歌手丙' && dec.meta.album === '专辑丁'));
  check('decrypt-bridge 普通 mp3 透传 ID3 USLT 歌词', !!(dec.lyric && dec.lyric.includes('id3歌词')));
  // 透传的标签歌词也能被歌词引擎命中
  if (dec.lyric) {
    const eng = createMobileLyricEngine({ dir: '', fsx: memoryFsx() });
    eng.setEmbeddedLyric(dec.name, dec.lyric);
    const res = await getLyric(eng, { trackId: dec.name, path: dec.name, title: dec.meta.title, artist: dec.meta.artist });
    check('普通 mp3 标签歌词经引擎命中 embedded', res.found && res.source === 'embedded');
  } else check('普通 mp3 标签歌词经引擎命中 embedded', false);
}

// ---- 7) 曲库语义去重闭环（验证 identity-bridge 纯函数经 app 标注可用）----
{
  // 模拟扫描 enrich 后的曲库：同一首歌有三个来源（flac 高音质 / mp3 / ncm 解密后实为 mp3）
  const lib = [
    { name: '歌A.flac', title: '歌A', artist: '甲', album: '专辑1', format: 'flac', ext: 'flac' },
    { name: '歌A.mp3', title: '歌A', artist: '甲', album: '专辑1', format: 'mp3', ext: 'mp3' },
    { name: '歌A.ncm', title: '歌A', artist: '甲', album: '专辑1', format: 'mp3', ext: 'ncm' },
    { name: '歌B.mp3', title: '歌B', artist: '乙', album: '专辑2', format: 'mp3', ext: 'mp3' },
  ];
  const groups = duplicateGroups(lib);
  check('identity: 识别出 1 个精确重复组(歌A 三版本)', groups.length === 1 && groups[0].type === 'exact' && groups[0].indices.length === 3);
  const annotated = annotateDuplicates(lib);
  const keep = annotated.find(t => t._dupKeep);
  const dups = annotated.filter(t => t._dup);
  check('identity: 推荐保留版本为 flac(音质最高)', !!(keep && keep.format === 'flac'));
  check('identity: 标记 2 个重复项(mp3/ncm)', dups.length === 2);
  check('identity: 唯一歌B 不被错标为重复/保留', annotated[3]._dup !== true && annotated[3]._dupKeep !== true);
}

// ---- 8) 仓库自包含护栏（防回归）----
// 背景：早期用 '../../../core/...' 逃逸 import 到桌面端 core，本机测试因桌面项目在旁而通过，
// 但 mobile 作为独立仓库推 CI 后该路径不存在 → npm run build 失败 → 永远出不了 APK。
// 这里做硬护栏：vendored 核心必须齐全，且 src 下任何相对 import 都不得解析到 mobile 目录之外。
{
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/tools
  const repoRoot = path.resolve(here, '..', '..');           // mobile/
  const decDir = path.join(repoRoot, 'src', 'core', 'decoders');
  const REQUIRED = ['ncmdecrypt.js', 'qqdecrypt.js', 'metadata_browser.js', 'aes128_ecb.js', 'lyricengine.js', 'lyrics.js', 'package.json'];
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(decDir, f)));
  check('自包含: decoders 解密/歌词核心齐全' + (missing.length ? '(缺:' + missing.join(',') + ')' : ''), missing.length === 0);

  let pkgType = null;
  try { pkgType = JSON.parse(fs.readFileSync(path.join(decDir, 'package.json'), 'utf8')).type; } catch (e) { /* 读不到则由上一条已报缺 */ }
  check('自包含: decoders/package.json 标记 commonjs', pkgType === 'commonjs');

  const jsFiles = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); }
      else if (p.endsWith('.js')) jsFiles.push(p);
    }
  })(path.join(repoRoot, 'src'));

  const escaped = [];
  const re = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
  for (const p of jsFiles) {
    const code = fs.readFileSync(p, 'utf8');
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;               // 裸包名（node_modules）跳过
      const resolved = path.resolve(path.dirname(p), spec);
      const inside = resolved === repoRoot || resolved.startsWith(repoRoot + path.sep);
      if (!inside) { escaped.push(path.relative(repoRoot, p) + ' -> ' + spec); break; }
    }
  }
  check('自包含: src 下无逃出 mobile 目录的 import' + (escaped.length ? '(' + escaped.join('; ') + ')' : ''), escaped.length === 0);
}

console.log(ok ? '\n✅ mobile 静态自检全部通过' : '\n❌ mobile 静态自检存在失败项');
process.exit(ok ? 0 : 1);
