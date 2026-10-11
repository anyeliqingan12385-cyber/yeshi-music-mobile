/* 网页版闭环测试（Node 下跑，无需浏览器）：
 * 复用与网页端 src/web/main.js 完全相同的核心模块（decrypt-bridge / player /
 * lyric-bridge / identity-bridge），用 MockAudio + URL.createObjectURL 替身，
 * 验证「解密 → 播放器生成 URL → 歌词引擎 → 语义去重标注」整链路在网页形态下也能闭环。
 *
 * 与 integration-test.js 的区别：integration 走 Capacitor 异步读文件（mock-loader），
 * 这里走网页端的 File API 形态（直接给字节），证明网页端入口的核心管线没问题。
 */
import { decryptFile, isEncryptedName, isMusicExtension, decryptedToObjectURL } from '../core/decrypt-bridge.js';
import { createMobileLyricEngine, getLyric, sidecarPath } from '../core/lyric-bridge.js';
import { annotateDuplicates } from '../core/identity-bridge.js';
import { Player } from '../core/player.js';

// ---- DOM / 浏览器 API 替身 ----
const created = [];
class MockAudio {
  constructor() { this.src = ''; this.currentTime = 0; this.duration = 0; this.paused = true; this._l = {}; created.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  addEventListener(e, cb) { (this._l[e] = this._l[e] || []).push(cb); }
  removeEventListener() {}
  removeAttribute() {}
}
globalThis.Audio = MockAudio;
let urlCount = 0;
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = (b) => 'blob:mock/' + (++urlCount);
globalThis.URL.revokeObjectURL = () => {};

// ---- 极简 ID3v2.3 构造（与 metadata_browser.parseID3v2 对齐）----
const _enc = new TextEncoder();
function utf8(s) { return _enc.encode(s); }
function latin1(s) { return new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff)); }
function u32be(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
// 文本帧：编码 0x03 = UTF-8（中文需此编码）
function textFrame(id, text) {
  const tb = utf8(text);
  const data = concat(new Uint8Array([0x03]), tb);
  return concat(latin1(id), u32be(data.length), new Uint8Array([0, 0]), data);
}
function usltFrame(lyric) {
  const lb = utf8(lyric);
  const data = concat(new Uint8Array([0x03]), latin1('eng'), new Uint8Array([0x00]), lb);
  return concat(latin1('USLT'), u32be(data.length), new Uint8Array([0, 0]), data);
}
function buildMp3({ title, artist, album, lyric }) {
  const frames = concat(textFrame('TIT2', title), textFrame('TPE1', artist), textFrame('TALB', album), usltFrame(lyric));
  const size = frames.length;
  const header = concat(latin1('ID3'), new Uint8Array([0x03, 0x00, 0x00]), u32be(size));
  const body = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]); // 合法 mp3 帧头占位
  return concat(header, frames, body);
}

// ---- 断言工具 ----
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

async function run() {
  console.log('网页端闭环测试：');

  // 1) 解密：普通 mp3（带 ID3 标签 + USLT 歌词）走网页端解密桥
  const mp3 = buildMp3({ title: '测试歌', artist: '测试人', album: '测试辑', lyric: '[00:01.00]第一行\n[00:02.00]第二行' });
  const dec = await decryptFile({ name: 'sub/测试歌.mp3', bytes: mp3 });
  ok('解密普通 mp3 → format=mp3', dec.format === 'mp3', 'got ' + dec.format);
  ok('mp3 标签解析出标题', dec.meta && (dec.meta.title === '测试歌'), JSON.stringify(dec.meta));
  ok('mp3 标签解析出歌手', dec.meta && dec.meta.artist === '测试人');
  ok('mp3 透传 USLT 歌词', typeof dec.lyric === 'string' && dec.lyric.includes('第一行'), dec.lyric);

  // 2) 解密：加密名判定（网页端同样需要识别 ncm/qq）
  ok('isEncryptedName 识别 ncm', isEncryptedName('x.ncm') === true);
  ok('isMusicExtension 识别 mp3/flac', isMusicExtension('a.mp3') && isMusicExtension('b.flac'));

  // 3) 播放器：生成 ObjectURL（网页端靠 Blob URL 喂 <audio>）
  const p = new Player();
  let threw = false;
  try { p.load(dec); } catch (e) { threw = true; console.log('    load err', e.message); }
  ok('Player.load 生成音频 URL（不抛错）', !threw && typeof p.audio.src === 'string' && p.audio.src.startsWith('blob:mock/'), p.audio.src);
  ok('URL 计数+1', urlCount >= 1);

  // 4) 歌词引擎：内嵌歌词登记 → 取词命中
  const engine = createMobileLyricEngine({});
  engine.setEmbeddedLyric('sub/测试歌.mp3', dec.lyric);
  const ly = await getLyric(engine, { trackId: 'sub/测试歌.mp3', path: 'sub/测试歌.mp3', title: '测试歌', artist: '测试人' }, {});
  ok('歌词引擎解析出时间轴', ly && ly.lines && ly.lines.length >= 2, JSON.stringify(ly && ly.lines));
  ok('歌词首行文本正确', ly && ly.lines && ly.lines[0] && ly.lines[0].text === '第一行');

  // 5) 同名 .lrc 优先级（网页端 readSidecar 由 main.js 用 File 实现，这里验证 sidecarPath 推导）
  ok('sidecarPath 推导同名 .lrc', sidecarPath('sub/测试歌.mp3') === 'sub/测试歌.lrc');

  // 6) 语义去重：同一首歌两个版本（mp3 + flac）→ 标重复、保留音质更高者
  const tracks = [
    { name: 'a.mp3', title: '同一首', artist: '某人', album: '辑', format: 'mp3' },
    { name: 'a.flac', title: '同一首', artist: '某人', album: '辑', format: 'flac' },
    { name: 'b.mp3', title: '另一首', artist: '别人', album: '辑', format: 'mp3' },
  ];
  const ann = annotateDuplicates(tracks);
  ok('去重识别重复组（2 首同曲）', ann[0]._dup === true && ann[1]._dupKeep === true);
  ok('保留版本为 flac（音质更高）', ann[1]._dupKeep === true && ann[0]._dup === true, 'mp3._dup=' + ann[0]._dup + ' flac._dupKeep=' + ann[1]._dupKeep);
  ok('无关曲目不打标', ann[2]._dup !== true && ann[2]._dupKeep !== true);

  console.log('\n网页端闭环：' + (fail === 0 ? '✅ 全部通过 (' + pass + ')' : '❌ ' + fail + ' 项失败 / ' + pass + ' 通过'));
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
