/* ============================================================================
 * core/metadata_browser.js —— 纯浏览器版标签/质量解析（手机端 Web/WebView 用）
 * ----------------------------------------------------------------------------
 * 这是 desktop/core/metadata.js 的「零依赖移植」：同样覆盖 FLAC/MP3/MP4/OGG/
 * WAV/AIFF/APE 容器与 ID3v2 / Vorbis comment / MP4 ilst 标签，但：
 *   - 不 require('fs') / require('path')（桌面版仅这两处依赖 Node，且只在『文件路径』
 *     入参时才用；本文件只接受字节，彻底去掉）
 *   - 不依赖 Node Buffer 方法（toString('latin1')/readUInt32BE/...），改用
 *     DataView + TextDecoder，输入为 Uint8Array，浏览器/WebView 原生可用
 *
 * 保持与 metadata.js 同算法、同字段名，便于在 selfcheck 里做「同字节双版对比」验证等价。
 *
 * 入口：analyzeBytes(uint8, { ext }) → 同形状对象：
 *   { container, codec, sampleRate, bitrate, channels, duration, lossless,
 *     size, class, quality, qualityRank, tags, replayGain, ... }
 * ==========================================================================*/
'use strict';

/* --------------------------- 字节工具（Uint8Array 版） --------------------------- */
const _tdLatin1 = (typeof TextDecoder !== 'undefined') ? new TextDecoder('latin1') : null;
const _tdUtf8 = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;
const _tdUtf16LE = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-16le') : null;

function view(buf, off) { return new DataView(buf.buffer, buf.byteOffset + off, buf.byteLength - off); }
function u32be(b, o) { return view(b, o).getUint32(0, false); }
function u32le(b, o) { return view(b, o).getUint32(0, true); }
function u16be(b, o) { return view(b, o).getUint16(0, false); }
function u16le(b, o) { return view(b, o).getUint16(0, true); }
function i16be(b, o) { return view(b, o).getInt16(0, false); }
function i32le(b, o) { return view(b, o).getInt32(0, true); }
function u64be(b, o) { return view(b, o).getBigUint64(0, false); }

function latin1(b, a, c) {
  a = a || 0; c = (c == null) ? b.length : c;
  if (_tdLatin1) return _tdLatin1.decode(b.subarray(a, c)).replace(/\0+$/, '');
  let s = ''; for (let i = a; i < c; i++) s += String.fromCharCode(b[i]); return s.replace(/\0+$/, '');
}
function utf8(b, a, c) {
  a = a || 0; c = (c == null) ? b.length : c;
  if (_tdUtf8) return _tdUtf8.decode(b.subarray(a, c)).replace(/\0+$/, '');
  let s = ''; for (let i = a; i < c; i++) s += String.fromCharCode(b[i]); return s.replace(/\0+$/, '');
}
// ID3 文本帧编码：0=latin1,1=utf16(BOM),2=utf16BE(BOM),3=utf8
function id3text(b, a, c, enc) {
  if (enc === 0) return latin1(b, a, c);
  if (enc === 3) return utf8(b, a, c);
  // utf-16：可能带 BOM（0xFEFF），去掉
  let s = _tdUtf16LE ? _tdUtf16LE.decode(b.subarray(a, c)) : '';
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s.replace(/\0+$/, '');
}
function syncsafe(b, o) { o = o || 0; return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f); }
function indexOfBytes(b, pat, from) {
  from = from || 0;
  const n = pat.length;
  if (!n) return -1;
  for (let i = from; i + n <= b.length; i++) {
    let ok = true; for (let j = 0; j < n; j++) { if (b[i + j] !== pat[j]) { ok = false; break; } }
    if (ok) return i;
  }
  return -1;
}

/* --------------------------- 码率/采样率表 --------------------------- */
const MPEG_BITRATE = {
  3: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const MPEG_SAMPLERATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseMPEGFrame(b, off) {
  if (!b || off == null || off + 4 > b.length) return null;
  if ((b[off] & 0xe0) !== 0xe0) return null;
  const versionBits = (b[off + 1] >> 3) & 0x03;
  const layerBits = (b[off + 1] >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;
  const version = versionBits === 3 ? 3 : 2;
  const layer = 4 - layerBits;
  const brIndex = (b[off + 2] >> 4) & 0x0f;
  const srIndex = (b[off + 2] >> 2) & 0x03;
  const padding = (b[off + 2] >> 1) & 0x01;
  const mode = (b[off + 3] >> 6) & 0x03;
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const bitrate = MPEG_BITRATE[version][layer][brIndex] * (layer === 1 ? 1 : 1000);
  const sampleRate = MPEG_SAMPLERATE[versionBits][srIndex];
  if (!bitrate || !sampleRate) return null;
  return { version, layer, sampleRate, bitrate, channels: mode === 3 ? 1 : 2, padding };
}

/* --------------------------- 标签归一化 --------------------------- */
function normalizeFields(map) {
  const m = {};
  for (const k of Object.keys(map || {})) m[String(k).toLowerCase().trim()] = map[k];
  const pick = (...keys) => { for (const k of keys) { const v = m[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; };
  const num = (...keys) => { const s = pick(...keys); if (!s) return null; const n = parseInt(String(s).split('/')[0], 10); return isFinite(n) ? n : null; };
  const out = {
    title: pick('title', 'name', 'song', '©nam', 'tit2'),
    artist: pick('artist', 'artists', 'album artist', 'albumartist', 'performer', 'lead performer', '©art', 'tpe1'),
    album: pick('album', 'publisher', '©alb', 'talb'),
    albumArtist: pick('album artist', 'albumartist', 'albumartists', 'aart', 'band', 'tpe2'),
    composer: pick('composer', 'composer (sorted)', '©com', 'copyrighted by', 'tcom'),
    genre: pick('genre', 'content type', '©gen', 'tcon'),
    year: pick('date', 'year', 'release date', 'recording date', '©day', 'tyer', 'tdrc'),
    trackNo: num('track number', 'track', 'trkn', 'tracknumber', 'track no', 'trck'),
    discNo: num('disc number', 'disc', 'disk', 'disck', 'disk number', 'tpos', 'part'),
    comment: pick('comment', 'comments', 'desc', 'description', '©cmt', 'comm'),
    copyright: pick('copyright', 'copyright message', 'cprt', '©cprt', 'tcop'),
    publisher: pick('publisher', 'label', 'organization', '©pub', 'tpub'),
    grouping: pick('grouping', 'content group', 'group', '©grp', 'grout', 'tit1'),
    isrc: pick('isrc', 'isrc t id3', 'tsrc', 'tsrc'),
    mbId: pick('musicbrainz artist id', 'musicbrainz release id', 'musicbrainz track id', 'musicbrainz album id', 'mbid', 'ufid'),
    bpm: num('bpm', 'tempo', 'tbpm', 'tmpo'),
    lyric: pick('lyrics', 'unsynchronised lyrics', 'lyric', 'uslt'),
    encoder: pick('encoder', 'encodersoftware', 'tsse', 'software'),
  };
  const y = out.year ? parseInt(String(out.year).slice(0, 4), 10) : null;
  out.year = y && y > 1000 && y < 3000 ? y : null;
  if (out.isrc) out.isrc = /^[A-Z]{2}[-]?[A-Z0-9]{3}[-]?[0-9]{2}[-]?[0-9]{5}$/i.test(out.isrc) ? out.isrc.toUpperCase() : '';
  if (out.mbId && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(out.mbId)) out.mbId = '';
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === '') delete out[k];
  return out;
}

function parseReplayGain(map) {
  const m = {};
  for (const k of Object.keys(map || {})) m[String(k).toLowerCase()] = map[k];
  const rg = { trackGain: null, albumGain: null, trackPeak: null, albumPeak: null, refLevel: 89 };
  const gain = (...keys) => { for (const k of keys) { const v = m[k]; if (v == null) continue; const mm = /-?\d+(?:\.\d+)?\s*dB/i.exec(String(v)); if (mm) { const n = parseFloat(mm[0]); if (isFinite(n)) return n; } } return null; };
  const peak = (...keys) => { for (const k of keys) { const v = m[k]; if (v == null) continue; const n = parseFloat(String(v).replace(/(db|peak|replaygain)/gi, '')); if (isFinite(n) && n > 0) return n; } return null; };
  rg.trackGain = gain('replaygain_track_gain', 'replaygain_album_gain', 'rgain:track gain');
  rg.albumGain = gain('replaygain_album_gain', 'replaygain_track_gain');
  rg.trackPeak = peak('replaygain_track_peak', 'replaygain_album_peak');
  rg.albumPeak = peak('replaygain_album_peak', 'replaygain_track_peak');
  if (m.replaygain_reference_volume) { const n = parseFloat(String(m.replaygain_reference_volume)); if (isFinite(n)) rg.refLevel = n; }
  return rg;
}

/* --------------------------- 各容器解析 --------------------------- */
function parseFLAC(buf) {
  const r = { container: 'flac', codec: 'FLAC', lossless: true, sampleRate: 0, bitDepth: 0, channels: 0, duration: 0, comments: {} };
  if (latin1(buf, 0, 4) !== 'fLaC') return null;
  let p = 4; let stream = null, vorbis = null;
  for (let guard = 0; guard < 64; guard++) {
    if (p + 4 > buf.length) break;
    const hdr = buf[p]; const last = !!(hdr & 0x80); const type = hdr & 0x7f;
    const len = ((buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
    const body = p + 4;
    if (type === 0 && !stream && body + 34 <= buf.length) stream = { off: body, len };
    if (type === 4 && !vorbis && body + 8 <= buf.length) vorbis = { off: body, len };
    p = body + len; if (last) break;
  }
  if (stream) {
    const b = stream.off; const q = b + 10;
    r.sampleRate = ((buf[q] << 12) | (buf[q + 1] << 4) | (buf[q + 2] >> 4)) >>> 0;
    r.channels = ((buf[q + 2] >> 1) & 0x07) + 1;
    r.bitDepth = (((buf[q + 2] & 0x01) << 4) | (buf[q + 3] >> 4)) + 1;
    const total = ((buf[q + 3] & 0x0f) * Math.pow(2, 32)) + (buf[q + 4] * 16777216) + (buf[q + 5] * 65536) + (buf[q + 6] * 256) + buf[q + 7];
    r.duration = r.sampleRate ? Math.round(total / r.sampleRate * 100) / 100 : 0;
  }
  if (vorbis) {
    let p2 = vorbis.off;
    const vlen = u32le(buf, p2); p2 += 4 + vlen;
    const cnt = u32le(buf, p2); p2 += 4;
    for (let i = 0; i < cnt && i < 512; i++) {
      const clen = u32le(buf, p2); p2 += 4;
      const entry = utf8(buf, p2, p2 + clen); p2 += clen;
      const eq = entry.indexOf('='); if (eq <= 0) continue;
      const key = entry.slice(0, eq); const val = entry.slice(eq + 1);
      if (r.comments[key]) r.comments[key] = r.comments[key] + '; ' + val; else r.comments[key] = val;
    }
  }
  return r;
}

function parseMP3(buf) {
  const r = { container: 'mp3', codec: 'MP3', lossless: false, sampleRate: 0, bitrate: 0, channels: 2, duration: 0, comments: {} };
  let audioStart = 0;
  if (latin1(buf, 0, 3) === 'ID3') {
    const ver = buf[3];
    const size = ver >= 4 ? syncsafe(buf, 6) : u32be(buf, 6);
    audioStart = 10 + size;
    r.comments = parseID3v2(buf.subarray(0, audioStart));
  }
  const start = Math.max(0, audioStart);
  let f = null, off = start;
  for (let i = 0; i < 64 && off + 4 <= buf.length; i++, off++) { f = parseMPEGFrame(buf, off); if (f) break; }
  if (!f) {
    for (let off2 = 0; off2 + 4 <= buf.length && off2 < buf.length; off2++) { f = parseMPEGFrame(buf, off2); if (f) break; }
    if (!f) return null;
  }
  r.sampleRate = f.sampleRate; r.bitrate = f.bitrate; r.channels = f.channels;
  r.channelsStr = f.channels === 1 ? 'Mono' : 'Stereo';
  const tlen = parseInt(r.comments.tlen, 10);
  if (isFinite(tlen) && tlen > 0) r.duration = tlen / 1000;
  r._frameStart = off;
  return r;
}

function parseID3v2(tagged) {
  const out = {};
  if (tagged.length < 10) return out;
  if (latin1(tagged, 0, 3) !== 'ID3') return out;
  const ver = tagged[3]; const flags = tagged[5];
  let size = ver >= 4 ? syncsafe(tagged, 6) : u32be(tagged, 6);
  let p = 10;
  if (flags & 0x10) { p += size; size = syncsafe(tagged, p); p += 4; }
  const end = Math.min(tagged.length, p + size);
  const isV24 = ver === 4;
  while (p + 10 <= end) {
    const id = latin1(tagged, p, p + 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let fsize = u32be(tagged, p + 4);
    if (isV24) fsize = syncsafe(tagged, p + 4);
    const body = p + 10;
    if (fsize <= 0 || body + fsize > end) break;
    const content = tagged.subarray(body, body + fsize);
    out[id] = decodeID3Frame(id, content);
    p = body + fsize;
  }
  return out;
}

function decodeID3Frame(id, c) {
  if (id === 'USLT') {
    const enc = c[0];
    // 正确跳过：编码(1) + 语言(3) + 内容描述符(以 NUL 结尾)，再读歌词正文
    // （桌面版 metadata.js 此处有 bug：从 c.length 起读基本返回空串，手机端按正确语义实现）
    let pos = 1 + 3;
    while (pos < c.length && c[pos] !== 0) pos++;
    if (pos < c.length) pos++;
    return c.length > pos ? id3text(c, pos, c.length, enc) : '';
  }
  if (id === 'RGAD') {
    if (c.length < 11) return '';
    const gainVal = i16be(c, 7) / 256;
    return 'REPLAYGAIN_GAIN ' + gainVal.toFixed(2) + ' dB';
  }
  if (id === 'APIC' || id === 'GEID' || id === 'UFID') return '';
  if (/^T[A-Z0-9]{2,3}$/.test(id)) {
    const enc = c[0];
    let text = '';
    try { text = c.length > 1 ? id3text(c, 1, c.length, enc) : ''; } catch (e) { text = ''; }
    if (id === 'TXXX') { const idx = text.indexOf('\0'); if (idx > 0) return text.slice(idx + 1); }
    return text.trim();
  }
  return utf8(c).replace(/^\0+/, '').replace(/\0+$/, '').trim();
}

function parseMP4(buf) {
  const r = { container: 'mp4', codec: '', lossless: false, sampleRate: 0, channels: 0, duration: 0, comments: {} };
  let p = 0; let mvhd = null, trak = null, udta = null, moovEnd = buf.length;
  while (p + 8 <= buf.length) {
    const size = u32be(buf, p); const type = latin1(buf, p + 4, p + 8);
    if (size < 8) break;
    const body = p + 8, end = Math.min(buf.length, body + size - 8);
    if (type === 'moov') {
      moovEnd = end;
      walkBoxes(buf, body, end, (off, t, b, e) => {
        if (t === 'mvhd' && !mvhd) mvhd = { off: b, end: e };
        if (t === 'trak' && !trak) trak = { off: b, end: e };
        if (t === 'udta' && !udta) udta = { off: b, end: e };
      });
      break;
    }
    p = end;
  }
  if (!mvhd && !trak) return null;
  if (mvhd) {
    const ver = buf[mvhd.off]; const o = mvhd.off + 4;
    if (ver === 1) { r._timescale = u32be(buf, o + 16); r._duration64 = Number(u64be(buf, o + 20)) / 1000 | 0; }
    else { r._timescale = u32be(buf, o + 8); r._duration32 = u32be(buf, o + 12); }
  }
  if (trak) {
    walkBoxes(buf, trak.off, trak.end, (off, t, b, e) => {
      if (t === 'mdia') {
        walkBoxes(buf, b, e, (o2, t2, b2, e2) => {
          if (t2 === 'mdhd') {
            const ver = buf[b2]; const o2b = b2 + 4;
            const ts = u32be(buf, o2b + (ver === 1 ? 16 : 8));
            const dur = ver === 1 ? Number(u64be(buf, o2b + 20)) : u32be(buf, o2b + 12);
            if (ts) { r._tTimescale = ts; r._tDuration = dur; }
          }
          if (t2 === 'hdlr') { const h = latin1(buf, b2 + 8, b2 + 12); if (h === 'soun') r._isAudio = true; }
          if (t2 === 'minf') walkBoxes(buf, b2, e2, (o3, t3, b3, e3) => { if (t3 === 'stbl') walkBoxes(buf, b3, e3, (o4, t4, b4, e4) => { if (t4 === 'stsd') r._stsd = { off: b4, end: e4 }; }); });
        });
      }
      if (t === 'udta' && !udta) udta = { off: b, end: e };
    });
  }
  if (udta) {
    walkBoxes(buf, udta.off, udta.end, (o5, t5, b5, e5) => {
      if (t5 === 'meta') walkBoxes(buf, b5 + 4, e5, (o6, t6, b6, e6) => { if (t6 === 'ilst') r._ilst = { off: b6, end: e6 }; });
      else if (t5 === 'ilst') r._ilst = { off: b5, end: e5 };
    });
  }
  if (r._tTimescale && r._tDuration != null) r.duration = Math.round(r._tDuration / r._tTimescale * 1000) / 1000;
  if (!r.duration && r._timescale) r.duration = Math.round((r._duration32 || r._duration64 || 0) / r._timescale * 1000) / 1000;
  if (r._stsd) {
    const e = r._stsd.off; const cnt = u32be(buf, e);
    if (cnt > 0) {
      const eo = e + 4; const fmt = latin1(buf, eo + 4, eo + 8); const infoOff = eo + 8; const code = fmt.slice(0, 4);
      if (code === 'mp4a') {
        r.codec = 'AAC'; r.channels = u16be(buf, infoOff + 16) || 2; r.bitDepth = u16be(buf, infoOff + 18) || 16;
        const sr32 = u32be(buf, infoOff + 24) >>> 0; r.sampleRate = Math.round(sr32 / 65536);
      } else if (code === 'alac') {
        r.codec = 'ALAC'; r.lossless = true; r.channels = u16be(buf, infoOff + 16) || 2; r.bitDepth = 16;
        const sr32 = u32be(buf, infoOff + 24) >>> 0; r.sampleRate = Math.round(sr32 / 65536);
      } else { r.codec = code; r.channels = u16be(buf, infoOff + 16) || 2; const sr32 = u32be(buf, infoOff + 24) >>> 0; if (sr32) r.sampleRate = Math.round(sr32 / 65536); }
    }
  }
  if (r._ilst) walkBoxes(buf, r._ilst.off, r._ilst.end, (o, t, b, e) => {
    const key = t; let val = '';
    walkBoxes(buf, b, e, (o2, t2, b2, e2) => {
      if (t2 === 'data') {
        const s = b2 + 8, en = e2;
        if (s < en) {
          const raw = buf.subarray(s, en);
          if (key === 'trkn' || key === 'disk') {
            const a = raw.length >= 6 ? ((raw[2] << 8) | raw[3]) : ((raw[0] << 8) | raw[1]);
            const c = raw.length >= 6 ? ((raw[4] << 8) | raw[5]) : 0;
            val = String(a) + (c ? '/' + c : '');
          } else val = utf8(buf, s, en).replace(/\0+$/, '').trim();
        }
        return true;
      }
      return false;
    }, true);
    if (val) r.comments[key] = val;
    return false;
  });
  if (r.codec === 'AAC') r.lossless = false;
  return r;
}

function walkBoxes(buf, start, end, fn, collectAll) {
  let p = start; let guard = 0;
  while (p + 8 <= end && guard++ < 4096) {
    let size = u32be(buf, p); const type = latin1(buf, p + 4, p + 8);
    let body = p + 8, e;
    if (size === 1) { size = Number(u64be(buf, p + 8)); body = p + 16; }
    if (size < 8) size = 8;
    e = Math.min(end, body + (size - 8));
    if (fn(p, type, body, e)) { if (!collectAll) return true; }
    p = e;
  }
  return false;
}

function parseOGG(buf) {
  if (latin1(buf, 0, 4) !== 'OggS') return null;
  const nseg = buf[26] || 1; const off = 27 + nseg;
  if (latin1(buf, off, off + 7) === '\x01vorbis') {
    const r = { container: 'ogg', codec: 'Vorbis', lossless: false, sampleRate: 0, channels: 2, bitrate: 0, duration: 0, comments: {} };
    r.channels = buf[off + 11] || 2; r.sampleRate = u32le(buf, off + 12) || 0;
    r.bitrate = Math.round(i32le(buf, off + 20) / 1000) || 0;
    const idx = indexOfBytes(buf, [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);
    if (idx > 0) {
      const p = idx + 7; const vlen = u32le(buf, p); let q = p + 4 + vlen; const cnt = u32le(buf, q); q += 4;
      for (let i = 0; i < cnt && i < 512; i++) { const cl = u32le(buf, q); q += 4; const entry = utf8(buf, q, q + cl); q += cl; const eq = entry.indexOf('='); if (eq > 0) r.comments[entry.slice(0, eq)] = entry.slice(eq + 1); }
    }
    return r;
  }
  if (latin1(buf, off, off + 8) === 'OpusHead') {
    const r = { container: 'ogg', codec: 'Opus', lossless: false, sampleRate: 48000, channels: 2, bitrate: 0, duration: 0, comments: {} };
    r.channels = buf[off + 9] || 2; r.bitrate = 0;
    const idx = indexOfBytes(buf, Array.from('OpusTags').map(c => c.charCodeAt(0)));
    if (idx > 0) {
      const p = idx + 8; const vlen = u32le(buf, p); let q = p + 4 + vlen; const cnt = u32le(buf, q); q += 4;
      for (let i = 0; i < cnt && i < 512; i++) { const cl = u32le(buf, q); q += 4; const entry = utf8(buf, q, q + cl); q += cl; const eq = entry.indexOf('='); if (eq > 0) r.comments[entry.slice(0, eq)] = entry.slice(eq + 1); }
    }
    return r;
  }
  if (latin1(buf, off, off + 5) === '\x07FLAC') {
    const r = { container: 'ogg', codec: 'FLAC', lossless: true, sampleRate: 0, channels: 2, bitrate: 0, duration: 0, comments: {} };
    const si = off + 18;
    if (si + 8 <= buf.length) {
      r.sampleRate = ((buf[si] << 12) | (buf[si + 1] << 4) | (buf[si + 2] >> 4)) >>> 0;
      r.channels = ((buf[si + 2] >> 1) & 0x07) + 1;
      r.bitDepth = (((buf[si + 2] & 0x01) << 4) | (buf[si + 3] >> 4)) + 1;
    }
    return r;
  }
  return null;
}

function parseWAV(buf) {
  if (latin1(buf, 0, 4) !== 'RIFF' || latin1(buf, 8, 12) !== 'WAVE') return null;
  const r = { container: 'wav', codec: 'PCM', lossless: true, sampleRate: 0, bitDepth: 0, channels: 2, duration: 0, comments: {} };
  let p = 12, dataBytes = 0;
  while (p + 8 <= buf.length) {
    const size = u32le(buf, p + 4); const type = latin1(buf, p, p + 4); const body = p + 8, end = Math.min(buf.length, body + size);
    if (type === 'fmt ') {
      r.channels = u16le(buf, body + 2) || 2; r.sampleRate = u32le(buf, body + 4) || 0; r.bitDepth = u16le(buf, body + 14) || 16;
      r.lossless = true;
    } else if (type === 'data') { dataBytes = size; }
    else if (type === 'LIST' && latin1(buf, body, body + 4) === 'INFO') {
      let q = body + 4;
      while (q + 8 <= end) {
        const cs = u32le(buf, q); const ct = latin1(buf, q + 4, q + 8); if (cs < 4) break;
        const cv = utf8(buf, q + 8, Math.min(end, q + 8 + cs));
        if (ct === 'INAM') r.comments.TIT2 = cv; else if (ct === 'IART') r.comments.TPE1 = cv; else if (ct === 'IPRD') r.comments.TALB = cv;
        else if (ct === 'ICRD') r.comments.TYER = cv; else if (ct === 'IGNR') r.comments.TCON = cv; else if (ct === 'ICMT') r.comments.COMM = cv;
        q += 8 + cs;
      }
    } else if (type === 'id3') { const t = parseID3v2(buf.subarray(body, end)); for (const k of Object.keys(t)) if (!r.comments[k]) r.comments[k] = t[k]; }
    p = end;
  }
  if (r.sampleRate && dataBytes) r.duration = Math.round(dataBytes / (r.sampleRate * r.channels * (r.bitDepth / 8)) * 100) / 100;
  r.channelsStr = r.channels === 1 ? 'Mono' : (r.channels === 2 ? 'Stereo' : r.channels + 'ch');
  return r;
}

function parseAIFF(buf) {
  if (latin1(buf, 0, 4) !== 'FORM' || latin1(buf, 8, 12) !== 'AIFF') return null;
  const r = { container: 'aiff', codec: 'PCM', lossless: true, sampleRate: 0, bitDepth: 0, channels: 2, duration: 0, comments: {} };
  let p = 12, ssnd = 0;
  while (p + 8 <= buf.length) {
    const size = u32be(buf, p + 4); const type = latin1(buf, p, p + 4); const body = p + 8, end = Math.min(buf.length, body + size);
    if (type === 'COMM') {
      r.channels = u16be(buf, body) || 2; r.bitDepth = u16be(buf, body + 6);
      const e16 = ((buf[body + 8] << 8) | buf[body + 9]) & 0x7fff; const neg = !!(buf[body + 8] & 0x80);
      const frac = u64be(buf, body + 10);
      if (e16 === 0 || e16 === 0x7fff) { r.sampleRate = 0; }
      else {
        const sig = (BigInt(1) << BigInt(64)) | frac; const e = e16 - 16383; let v;
        if (e >= 64) v = Number(sig) * Math.pow(2, e - 64);
        else { const sh = BigInt(64 - e); const den = (BigInt(1) << sh); const hi = Number(sig / den); const lo = Number(sig % den) / Number(den); v = hi + lo; }
        if (neg) v = -v;
        r.sampleRate = isFinite(v) && v > 0 ? Math.round(v) : 0;
      }
    } else if (type === 'SSND') { ssnd = size; }
    else if (type === 'ID3 ') { const t = parseID3v2(buf.subarray(body, end)); for (const k of Object.keys(t)) if (!r.comments[k]) r.comments[k] = t[k]; }
    p = end;
  }
  if (r.sampleRate && ssnd) r.duration = Math.round(ssnd / (r.sampleRate * r.channels * (r.bitDepth / 8)) * 100) / 100;
  r.channelsStr = r.channels === 1 ? 'Mono' : (r.channels === 2 ? 'Stereo' : r.channels + 'ch');
  return r;
}

function parseAPE(buf) {
  if (latin1(buf, 0, 4) !== 'MAC ') return null;
  const r = { container: 'ape', codec: 'APE', lossless: true, sampleRate: 0, bitDepth: 0, channels: 2, duration: 0, comments: {} };
  const ver = u16le(buf, 4); const o = ver < 3980 ? 12 : 8;
  if (buf.length < o + 16) return null;
  r.sampleRate = u32le(buf, o) || 0; r.bitDepth = u16le(buf, o + 4); r.channels = u16le(buf, o + 6) || 2;
  const total = u32le(buf, o + 12);
  if (r.sampleRate && total) r.duration = Math.round(total / r.sampleRate * 100) / 100;
  return r;
}

/* --------------------------- 质量分级 --------------------------- */
function classify(o) {
  if (!o.sampleRate && !o.duration && !o.bitrate) return 'unknown';
  if (o.lossless) {
    if (o.bitDepth && o.bitDepth > 16) return 'true-lossless';
    if (o.sampleRate > 48000) return 'high-res';
    if (o.bitDepth === 16 && o.sampleRate >= 44100) return 'true-lossless';
    return 'lossless';
  }
  const k = (o.bitrate || 0) / 1000;
  if (k >= 256) return 'lossy-high';
  if (k >= 128) return 'lossy';
  if (k > 0) return 'lossy-low';
  return 'unknown';
}
const QUALITY_LABEL = { 'true-lossless': '无损', 'high-res': '高清无损', 'lossless': '无损', 'lossless-cd': 'CD 无损', 'lossy-high': '有损 高码率', 'lossy': '有损', 'lossy-low': '有损 低码率', 'unknown': '未知' };
const QUALITY_RANK = { 'true-lossless': 100, 'high-res': 95, 'lossless-cd': 90, 'lossless': 70, 'lossy-high': 60, 'lossy': 40, 'lossy-low': 20, 'unknown': 0 };

/* --------------------------- 对外入口 --------------------------- */
/**
 * 分析一段音频字节（Uint8Array / Buffer 均可，浏览器端传 Uint8Array）。
 * @param {Uint8Array} input 音频字节（无需文件路径）
 * @param {object} [opt] { ext: 'mp3'|'flac'|... 扩展名提示（可选，优先按字节嗅探） }
 */
function analyzeBytes(input, opt) {
  const o = opt || {};
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!buf || !buf.length) return null;
  const ext = (o.ext || '').toLowerCase();
  let r = null, kind = ext;
  const head = latin1(buf, 0, Math.min(12, buf.length));
  if (head.indexOf('fLaC') === 0) kind = 'flac';
  else if (head.indexOf('ID3') === 0 || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) kind = 'mp3';
  else if (head.indexOf('OggS') === 0) kind = 'ogg';
  else if (head.indexOf('RIFF') === 0) kind = 'wav';
  else if (head.indexOf('FORM') === 0) kind = 'aiff';
  else if (head.indexOf('MAC ') === 0) kind = 'ape';
  else if (head.indexOf('ftyp') >= 0) kind = 'mp4';
  else if (ext) kind = ext;

  try {
    if (kind === 'flac') r = parseFLAC(buf);
    else if (kind === 'mp3') r = parseMP3(buf);
    else if (kind === 'mp4' || kind === 'm4a' || kind === 'm4b' || kind === 'mp4v') r = parseMP4(buf);
    else if (kind === 'ogg' || kind === 'oga' || kind === 'opus') r = parseOGG(buf);
    else if (kind === 'wav') r = parseWAV(buf);
    else if (kind === 'aiff' || kind === 'aif' || kind === 'aifc') r = parseAIFF(buf);
    else if (kind === 'ape') r = parseAPE(buf);
  } catch (e) { r = null; }
  if (!r) return null;

  r.size = buf.length;
  r.file = '';
  if (!r.duration && r.bitrate && r.size) r.duration = Math.round(r.size * 8 / (r.bitrate * 1000) * 100) / 100;
  if (!r.bitrate && r.container === 'flac' && r.duration) r.bitrate = Math.round(r.size * 8 / r.duration / 1000);
  if (!r.bitrate && r.container === 'ape' && r.duration) r.bitrate = Math.round(r.size * 8 / r.duration / 1000);
  if (!r.channelsStr) r.channelsStr = r.channels === 1 ? 'Mono' : (r.channels === 2 ? 'Stereo' : (r.channels + 'ch'));
  if (!r.bitDepth && !r.lossless) r.bitDepth = null;

  r.tags = normalizeFields(r.comments || {});
  const rg = parseReplayGain(r.comments || {});
  r.replayGain = (rg.trackGain != null || rg.albumGain != null) ? rg : null;
  r.class = classify(r);
  r.quality = QUALITY_LABEL[r.class] || '未知';
  r.qualityRank = QUALITY_RANK[r.class] || 0;
  r.bitrateLabel = r.bitrate ? (r.bitrate >= 1000 ? Math.round(r.bitrate / 100) / 10 + ' Mbps' : r.bitrate + ' kbps') : '';
  return r;
}

const API = { analyzeBytes, normalizeFields, parseReplayGain, classify, QUALITY_LABEL, QUALITY_RANK, parseID3v2, parseFLAC, parseMP3, parseMP4, parseOGG, parseWAV, parseAIFF, parseAPE };
if (typeof module === 'object' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.MetadataBrowser = API;
else if (typeof globalThis !== 'undefined') globalThis.MetadataBrowser = API;
