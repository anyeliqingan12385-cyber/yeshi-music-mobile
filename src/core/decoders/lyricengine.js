/* ============================================================================
 * LyricEngine —— 阶段 E
 * ----------------------------------------------------------------------------
 * 路线图十七：歌词要有「多来源优先级」，按可信度依次尝试，命中即用：
 *
 *   1) manual  用户手动指定/手动改过的        —— 最高，永远优先
 *   2) sidecar 同目录同名 .lrc（用户特意放的）—— 比内嵌准
 *   3) embedded 文件内嵌（ID3 USLT / Vorbis LYRICS / MP4 ©lyr）
 *   4) source  在线来源（QQ/网易/本地歌词库）  —— 需要匹配对得上
 *   5) none    都没有                          —— 如实说没有，不编
 *
 * 关键设计：
 *   - 缓存按 lyricId（core/ids.js lyricId，歌名+歌手+时长派生）落盘，
 *     所以同一首歌下次打开不用重新解码音频找内嵌歌词；
 *   - 每条缓存记录里存了「来源」和「原始文本」，用户随时能看清
 *     这份歌词是哪来的、并一键切到别的来源（这比默默生效重要得多）。
 *
 * 纯逻辑 + 一个可注入的 fs 适配层，因此可无 GUI 单测（tools/test_lyricengine.js）。
 * ==========================================================================*/

const L = require('./lyrics');

/** 来源优先级：数字越小越优先 */
const SOURCES = {
  manual:   { rank: 1, label: '手动指定' },
  sidecar:  { rank: 2, label: '本地同名文件' },
  embedded: { rank: 3, label: '文件内嵌' },
  source:   { rank: 4, label: '在线来源' },
  none:     { rank: 99, label: '无' },
};
const SOURCE_ORDER = ['manual', 'sidecar', 'embedded', 'source'];

class LyricEngine {
  /**
   * @param {object} opt
   *   - dir        缓存目录（建议 <userData>/lyrics）
   *   - fsx        { readFile, writeFile, exists, readdir }  可注入，便于测试
   *   - getTrack   (trackId) => track  取曲库记录
   *   - getManual  (trackId) => {text, offsetMs, updatedAt} 用户手动指定的
   *   - setManual  (trackId, obj) => void
   *   - online     (track) => {text, from, offsetMs?}  在线来源取词（可选）
   *   - extractEmbedded (filePath) => {text, offsetMs?}  从音频文件抽内嵌歌词
   *   - findSidecar (filePath, title, artist) => {path, text, offsetMs?} 找同名 lrc
   */
  constructor(opt) {
    const o = opt || {};
    this.dir = o.dir || '';
    this.fsx = o.fsx || null;
    this.getTrack = o.getTrack || (() => null);
    this.getManual = o.getManual || (() => null);
    this.setManual = o.setManual || (() => {});
    this.online = o.online || null;
    this.extractEmbedded = o.extractEmbedded || null;
    this.findSidecar = o.findSidecar || null;
    this._mem = new Map();      // 内存缓存，避免同一首歌反复读盘
  }

  /* ------------------------- 缓存读写 ------------------------- */
  _cachePath(lyricId) {
    if (!this.dir || !lyricId) return '';
    const safe = String(lyricId).replace(/[^\w\-.]/g, '_');
    return this.dir + (this.dir.endsWith('/') || this.dir.endsWith('\\') ? '' : '/') + safe + '.json';
  }

  readCache(lyricId) {
    if (this._mem.has(lyricId)) return this._mem.get(lyricId);
    if (!this.fsx || !this._cachePath(lyricId)) return null;
    try {
      if (!this.fsx.exists(this._cachePath(lyricId))) return null;
      const raw = this.fsx.readFile(this._cachePath(lyricId), 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj.text === 'string' && obj.text) {
        this._mem.set(lyricId, obj);
        return obj;
      }
    } catch (e) { /* 缓存坏了就当没有，重新找 */ }
    return null;
  }

  writeCache(lyricId, rec) {
    if (!lyricId) return null;
    const obj = Object.assign({ updatedAt: Date.now() }, rec || {});
    this._mem.set(lyricId, obj);
    if (this.fsx && this._cachePath(lyricId)) {
      try { this.fsx.writeFile(this._cachePath(lyricId), JSON.stringify(obj)); } catch (e) {}
    }
    return obj;
  }

  clearCache(lyricId) {
    this._mem.delete(lyricId);
    if (this.fsx && this._cachePath(lyricId)) {
      try { if (this.fsx.exists(this._cachePath(lyricId))) this.fsx.unlink(this._cachePath(lyricId)); } catch (e) {}
    }
  }

  /* ------------------------- 取歌词 ------------------------- */
  /**
   * 按优先级给一首歌找歌词。
   * @param {object} track 曲目（要含 trackId/title/artist/path/duration）
   * @param {object} opt { force: 'manual'|'sidecar'|'embedded'|'source' 强制某个来源 }
   * @returns {{found:boolean, source:string, sourceLabel:string, text:string, offsetMs:number, lines:Array, from?:string, cached:boolean}}
   */
  async get(track, opt) {
    const o = opt || {};
    const t = track || {};
    const lyricId = t.lyricId || t.trackId || '';
    const empty = { found: false, source: 'none', sourceLabel: SOURCES.none.label, text: '', offsetMs: 0, lines: [], cached: false };

    // 0) 强制来源
    if (o.force && SOURCES[o.force] && o.force !== 'none') {
      const rec = await this._fromSource(o.force, t);
      if (rec && rec.text) return this._finish(lyricId, rec, true);
      return empty;
    }

    // 1) 手动指定（最高优先级，且不写缓存——手动是"此刻"的）
    const manual = this._try(() => this.getManual(lyricId));
    if (manual && manual.text) {
      return this._finish(lyricId, { source: 'manual', text: manual.text, offsetMs: manual.offsetMs || 0 }, false);
    }

    // 2) 缓存（上次找到的来源直接复用，避免重复解码音频）
    const cached = this.readCache(lyricId);
    if (cached && cached.text) {
      return this._finish(lyricId, cached, true, true);
    }

    // 3) 按优先级依次尝试（sidecar 读取是异步的，必须 await）
    for (const src of ['sidecar', 'embedded', 'source']) {
      const rec = await this._fromSource(src, t);
      if (rec && rec.text) {
        this.writeCache(lyricId, rec);      // 找到就缓存，下次直接用
        return this._finish(lyricId, rec, false);
      }
    }
    return empty;
  }

  /** 尝试某个来源（每个来源都可能抛错/异步——文件损坏/网络不通/读取失败，都不能连带崩掉整首歌） */
  async _fromSource(src, t) {
    const rec = await this._tryAsync(async () => {
      if (src === 'sidecar') {
        if (!this.findSidecar) return null;
        const r = await this.findSidecar(t.path, t.title, t.artist); // 异步读取同名 .lrc（真机走 Capacitor Filesystem）
        return r && r.text ? { source: 'sidecar', text: r.text, offsetMs: r.offsetMs || 0, from: r.path } : null;
      }
      if (src === 'embedded') {
        if (!this.extractEmbedded) return null;
        const r = this.extractEmbedded(t.path);
        return r && r.text ? { source: 'embedded', text: r.text, offsetMs: r.offsetMs || 0 } : null;
      }
      if (src === 'source') {
        if (!this.online) return null;
        const r = this.online(t);
        return r && r.text ? { source: 'source', text: r.text, offsetMs: r.offsetMs || 0, from: r.from } : null;
      }
      return null;
    });
    return rec && rec.text ? rec : null;
  }

  _try(fn) { try { return fn(); } catch (e) { return null; } }
  async _tryAsync(fn) { try { return await fn(); } catch (e) { return null; } }

  _finish(lyricId, rec, fromCache, isCached) {
    const src = SOURCES[rec.source] || SOURCES.none;
    // core/lyrics.js 的 parse() 返回 { lines, untimed, meta, format }，
    // 歌词自身的 offset（文件头 [offset:...]）和用户设的 offsetMs 要叠在一起。
    let parsed = { lines: [], untimed: [], meta: {}, format: 'lrc' };
    try { parsed = L.parse(rec.text) || parsed; } catch (e) { /* 解析不了就当纯文本 */ }
    const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    let offsetMs = rec.offsetMs || 0;
    try {
      if (parsed.meta && parsed.meta.offset) {
        offsetMs += Number(parsed.meta.offset) || 0;
        if (lines.length) lines.sort((a, b) => (a.time || 0) - (b.time || 0));
      }
    } catch (e) {}
    return {
      found: true,
      source: rec.source,
      sourceLabel: src.label,
      text: rec.text,
      offsetMs,
      from: rec.from || '',
      lines,
      untimed: Array.isArray(parsed.untimed) ? parsed.untimed : [],
      format: parsed.format || 'lrc',
      cached: !!isCached,
    };
  }

  /* ------------------------- 手动覆盖 ------------------------- */
  /** 用户手动指定/修改歌词（最高优先级，不进自动缓存） */
  setManualLyric(track, text, offsetMs) {
    const t = track || {};
    const lyricId = t.lyricId || t.trackId || '';
    const rec = { source: 'manual', text: String(text || ''), offsetMs: Number(offsetMs) || 0, updatedAt: Date.now() };
    this._try(() => this.setManual(lyricId, rec));
    this._mem.set(lyricId, rec);     // 同一首歌立刻生效，不用等下次读盘
    return this._finish(lyricId, rec, false);
  }

  /** 取消手动，回到自动优先级 */
  clearManualLyric(track) {
    const t = track || {};
    const lyricId = t.lyricId || t.trackId || '';
    this._try(() => this.setManual(lyricId, null));
    this._mem.delete(lyricId);
  }

  /** 这首歌当前是「手动」来的吗（UI 上要显示出来） */
  isManual(track) {
    const t = track || {};
    const m = this._try(() => this.getManual(t.lyricId || t.trackId));
    return !!(m && m.text);
  }
}

const API = { LyricEngine, SOURCES, SOURCE_ORDER };
if (typeof module === 'object' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.LyricEngineMod = API;
else if (typeof globalThis !== 'undefined') globalThis.LyricEngineMod = API;
