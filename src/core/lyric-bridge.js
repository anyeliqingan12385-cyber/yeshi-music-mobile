/* 手机端歌词桥：复用桌面端 core/lyricengine.js（单一真相源），注入移动端适配层。
 *
 * 设计要点：
 *  - LyricEngine 本身纯逻辑 + 可注入 fsx（缓存落盘）/ extractEmbedded / findSidecar，
 *    不碰浏览器 API，因此可在 Node 下被 selfcheck 验证。
 *  - 移动端「内嵌歌词」优先用解密时已抽出的歌词（ncm 的 meta.lyric）：
 *    在 playTrack 时调用 engine.setEmbeddedLyric(path, text) 登记，避免重复解密音频。
 *  - sidecar（同名 .lrc）用注入的 readSidecar(audioPath) 实现（真机走 Capacitor Filesystem）。
 *
 * 双环境兼容：core 是 CJS，浏览器/Node 用默认导入即可（Node 经 cjs-module-lexer 取默认导出）。
 * 注意：require 这些 CJS 文件的活由 Vite/Node 的 CJS 互操作负责，本文件只做默认导入。
 */
import LyricEngineMod from './decoders/lyricengine.js';
import LMod from './decoders/lyrics.js';

const { LyricEngine, SOURCES, SOURCE_ORDER } = LyricEngineMod;
const { parse, at } = LMod;

/** 内存版 fsx（自测用；真机用 Capacitor Filesystem 适配层替换） */
export function memoryFsx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    readFile: (p) => m.get(p),
    writeFile: (p, c) => { m.set(p, String(c)); return true; },
    exists: (p) => m.has(p),
    unlink: (p) => { m.delete(p); return true; },
  };
}

/** 由音频路径推导同名 .lrc 路径 */
export function sidecarPath(audioPath) {
  const i = audioPath.lastIndexOf('.');
  return (i >= 0 ? audioPath.slice(0, i) : audioPath) + '.lrc';
}

/** 创建手机端歌词引擎
 * opt: {
 *   dir, fsx,
 *   readSidecar(audioPath) -> string|null   // 读同名 .lrc 内容；真机用 Capacitor Filesystem
 *   getManual(trackId) -> {text,offsetMs}|null,
 *   setManual(trackId, obj) -> void,
 *   online(track) -> {text, from}|null
 * }
 */
export function createMobileLyricEngine(opt = {}) {
  const o = opt || {};
  const embeddedCache = new Map(); // path -> 解密时已抽出的内嵌歌词文本
  const engine = new LyricEngine({
    dir: o.dir || '',
    fsx: o.fsx || null,
    getTrack: o.getTrack || (() => null),
    getManual: o.getManual || (() => null),
    setManual: o.setManual || (() => {}),
    online: o.online || null,
    // 内嵌歌词：优先用解密时登记的，避免重解音频
    extractEmbedded: (path) => {
      if (embeddedCache.has(path)) return { text: embeddedCache.get(path), offsetMs: 0 };
      return null;
    },
    // 同名 .lrc：真机走 Capacitor Filesystem（readSidecar 为异步读取，必须 await）
    findSidecar: async (path) => {
      if (!o.readSidecar) return null;
      const txt = await o.readSidecar(sidecarPath(path));
      if (txt) return { path: sidecarPath(path), text: txt, offsetMs: 0 };
      return null;
    },
  });
  // 解密后登记内嵌歌词（ncm 的 meta.lyric）
  engine.setEmbeddedLyric = (path, text) => { if (text) embeddedCache.set(path, String(text)); };
  engine.clearEmbeddedLyric = (path) => { embeddedCache.delete(path); };
  return engine;
}

/** 取歌词（封装 LyricEngine.get，统一入参）。track 需含 trackId/path/title/artist。异步：sidecar 读取是异步的 */
export async function getLyric(engine, track, opt) {
  return engine.get(track || {}, opt || {});
}

export { LyricEngine, SOURCES, SOURCE_ORDER, parse, at };
