/* 手机端端到端闭环集成测试
 * 用 mock 替换 @capacitor/filesystem / HTMLAudioElement / Blob-URL，在 Node 里真实跑通：
 *   扫描本地曲库 → 读字节 → 解密(ncm/qq/普通) → 播放器生成可播放 URL → 歌词登记 → 按播放时间轴取当前行
 * 并验证：曲库语义去重（identity 引擎）、同名 .lrc 优先级高于内嵌。
 * 不依赖真机/模拟器；运行：node --experimental-loader ./mock-loader.mjs integration-test.js
 */
import { Filesystem } from '@capacitor/filesystem';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { scanLibrary, readFileBytes } from '../core/scan.js';
import { decryptFile } from '../core/decrypt-bridge.js';
import { Player } from '../core/player.js';
import { createMobileLyricEngine, getLyric, at, sidecarPath } from '../core/lyric-bridge.js';
import { annotateDuplicates } from '../core/identity-bridge.js';

// ---------- 全局替身 ----------
class MockAudio {
  constructor() { this._src = ''; this._cur = 0; this._dur = 0; this._paused = true; this._l = {}; }
  addEventListener(ev, cb) { (this._l[ev] = this._l[ev] || []).push(cb); }
  removeEventListener(ev, cb) { if (this._l[ev]) this._l[ev] = this._l[ev].filter(f => f !== cb); }
  play() { this._paused = false; return Promise.resolve(); }
  pause() { this._paused = true; }
  load() { this._cur = 0; }
  removeAttribute() {}
  setAttribute() {}
  set src(v) { this._src = v; if (v) this._dur = 200; }
  get src() { return this._src; }
  get currentTime() { return this._cur; }
  set currentTime(v) { this._cur = v; }
  get duration() { return this._dur; }
  get paused() { return this._paused; }
}
globalThis.Audio = MockAudio;
let _blobN = 0;
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = () => 'blob:mock/' + (++_blobN);
globalThis.URL.revokeObjectURL = () => {};

let ok = true;
function check(name, cond) { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) ok = false; }

// ---------- fixture 构造 ----------
function toB64(buf) { return Buffer.from(buf).toString('base64'); }
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
  const audio = randomBytes(1024);
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
  return Buffer.concat([
    Buffer.from('CTENFDAM', 'latin1'), Buffer.alloc(2, 0),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(keyData.length); return b; })(), keyData,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(metaSeg.length); return b; })(), metaSeg,
    Buffer.alloc(4, 0), Buffer.alloc(5, 0),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0); return b; })(),
    Buffer.from(audioEnc),
  ]);
}
function buildFlacBytes({ title, artist, album, lyric }) {
  const si = Buffer.alloc(4 + 34); si[0] = 0x00; si[3] = 34; // 0=streaminfo 块, 长度 34
  const vendor = Buffer.from('X', 'latin1');
  const comments = [`TITLE=${title}`, `ARTIST=${artist}`, `ALBUM=${album}`, `LYRICS=${lyric}`];
  let body = Buffer.concat([Buffer.alloc(4), vendor, Buffer.alloc(4)]);
  body.writeUInt32LE(vendor.length, 0); body.writeUInt32LE(comments.length, 4 + vendor.length);
  for (const c of comments) { const cb = Buffer.from(c, 'utf8'); const part = Buffer.alloc(4 + cb.length); part.writeUInt32LE(cb.length, 0); cb.copy(part, 4); body = Buffer.concat([body, part]); }
  const vc = Buffer.alloc(4 + body.length); vc[0] = 0x84; vc[1] = (body.length >> 16) & 0xff; vc[2] = (body.length >> 8) & 0xff; vc[3] = body.length & 0xff; body.copy(vc, 4);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), si, vc]);
}
function id3v2Frame(id, data) { const buf = Buffer.alloc(4 + 4 + 2 + data.length); buf.write(id, 0, 'latin1'); buf.writeUInt32BE(data.length, 4); buf.writeUInt16BE(0, 8); data.copy(buf, 10); return buf; }
function buildMp3Bytes({ title, artist, album }) {
  const tf = (s) => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  const frames = [
    id3v2Frame('TIT2', tf(title)), id3v2Frame('TPE1', tf(artist)), id3v2Frame('TALB', tf(album)),
    id3v2Frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng', 'latin1'), Buffer.from([0]), Buffer.from('id3歌词第一行\n第二行', 'utf8')])),
  ];
  const tag = Buffer.concat(frames);
  const header = Buffer.alloc(10); header.write('ID3', 0, 'latin1'); header[3] = 3; header.writeUInt32BE(tag.length, 6);
  return Buffer.concat([header, tag, Buffer.from([0xff, 0xfb, 0x90, 0x00])]);
}

// ---------- 装配 mock 文件系统（模拟手机 ExternalStorage）----------
const fs = new Map();
fs.set('Music', { type: 'directory' });
fs.set('Music/emb.ncm', { type: 'file', data: toB64(buildNcm({ musicName: '内嵌曲', artist: '叶宗', lyric: '[ti:内嵌]\n[00:01.00]嵌入第一行\n[00:02.00]嵌入第二行\n' })) });
fs.set('Music/emb.lrc', { type: 'file', data: toB64(Buffer.from('[ti:sidecar]\n[00:01.00]侧car行1\n[00:02.00]侧car行2\n', 'utf8')) });
fs.set('Music/flac1.flac', { type: 'file', data: toB64(buildFlacBytes({ title: '同一首歌', artist: '歌手甲', album: '专辑乙', lyric: '[00:01.00] flac行1\n[00:02.00] flac行2\n' })) });
fs.set('Music/mp3_dup.mp3', { type: 'file', data: toB64(buildMp3Bytes({ title: '同一首歌', artist: '歌手甲', album: '专辑乙' })) });
fs.set('Music/plain.mp3', { type: 'file', data: toB64(buildMp3Bytes({ title: '另一首', artist: '歌手丙', album: '专辑丁' })) });
globalThis.__MOCK_FS__ = fs;

// ---------- 运行闭环 ----------
async function readSidecar(audioPath) {
  const p = sidecarPath(audioPath);
  try { const r = await Filesystem.readFile({ path: p, encoding: 'utf8' }); return typeof r.data === 'string' ? r.data : null; } catch (e) { return null; }
}

const player = new Player();
const engine = createMobileLyricEngine({ dir: '', readSidecar });

async function main() {
  const tracks = await scanLibrary();
  check('扫描过滤出 4 个音乐文件（.lrc 被正确排除）', tracks.length === 4);

  const enriched = [];
  for (const f of tracks) {
    const bytes = await readFileBytes(f.path, f.directory);
    check('读字节非空: ' + f.name, bytes && bytes.length > 0);
    const dec = await decryptFile({ name: f.name, bytes });
    check('解密成功: ' + f.name, !!dec && !!dec.bytes && dec.bytes.length > 0);

    const url = player.load(dec);
    check('播放器生成可播放 URL: ' + f.name, typeof url === 'string' && url.startsWith('blob:mock/'));
    player.unload();

    const m = dec.meta || {};
    const title = m.musicName || m.title || f.name;
    const artist = m.artist || '';
    const album = m.album || '';
    if (dec.lyric) engine.setEmbeddedLyric(f.path, dec.lyric);
    const track = { trackId: f.path, path: f.path, title, artist, duration: 0 };
    const res = await getLyric(engine, track);

    enriched.push({ name: f.name, format: dec.format, title, artist, album });

    if (f.name === 'emb.ncm') {
      // 内嵌 + 同名.lrc 同时存在 → 应命中 sidecar（优先级更高）
      check('emb.ncm 同名 .lrc 优先级高于内嵌歌词', res.found && res.source === 'sidecar' && res.lines[0].text === '侧car行1');
    } else if (f.name === 'flac1.flac') {
      check('flac 标签歌词经引擎命中', res.found && res.source === 'embedded' && res.lines.length === 2);
      const a = at(res.lines, 1500), b = at(res.lines, 2500);
      check('flac 歌词按时间轴取行正确', a.index === 0 && b.index === 1);
    } else if (f.name === 'plain.mp3') {
      check('mp3 USLT 歌词经引擎命中', res.found && res.source === 'embedded');
    }
  }

  // 曲库语义去重：flac1 + mp3_dup 应为同一首（exact 组），保留音质更高的 flac
  const ann = annotateDuplicates(enriched);
  const dupPairs = ann.filter(t => t._dup || t._dupKeep);
  check('语义去重识别到重复组', dupPairs.length === 2);
  const keep = ann.find(t => t._dupKeep && t.name === 'flac1.flac');
  const drop = ann.find(t => t._dup && t.name === 'mp3_dup.mp3');
  check('去重保留音质更高(flac)的版本', !!(keep && drop));

  console.log(ok ? '\n✅ 端到端闭环全部通过' : '\n❌ 端到端闭环存在失败项');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('集成测试异常:', e); process.exit(1); });
