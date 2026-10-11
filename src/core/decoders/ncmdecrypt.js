/*
 * core/ncmdecrypt.js — 网易云 NCM 解密器（.ncm → mp3/flac/ogg/m4a/wav）
 *
 * 格式：文件头 "CTENFDAM"，密钥段 XOR 0x64 后 AES-128-ECB 解出 key_data，
 * 去掉前缀 "neteasecloudmusic"(17B) 后构造 256 字节 key_box，
 * 音频正文按 data[i] ^= box[(box[j] + box[(box[j]+j)&0xff]) & 0xff]（j=(i+1)&0xff）还原。
 *
 * 本文件只做「纯解密」，不碰文件系统/缓存——缓存落盘由 main.js 的 decodeNcm() 负责
 * （仿 core/qqdecrypt.js 的分工）。
 *
 * 双路径 AES（2026-10-11 改造，为手机端/浏览器铺路）：
 *   - Node 侧：走 require('crypto') 的 AES-128-ECB（与改造前行为一致）
 *   - 浏览器/WebView 侧：Web Crypto 不支持 ECB，改走 core/aes128_ecb.js 的纯 JS 实现
 * 字节统一用 Uint8Array，不再依赖 Buffer（Node 侧返回值仍包回 Buffer 以兼容桌面端）。
 * UMD：Node 下 module.exports；浏览器/沙箱下挂到 window.NcmDecrypt。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { global.NcmDecrypt = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 环境探测：Node 端优先用 crypto，否则走纯 JS ----
  let nodeCrypto = null;
  try { if (typeof require === 'function') nodeCrypto = require('crypto'); } catch (e) { nodeCrypto = null; }
  let AES128 = null;
  if (!nodeCrypto) {
    try {
      if (typeof require === 'function') AES128 = require('./aes128_ecb');
      else AES128 = (typeof self !== 'undefined' && self.AES128) ? self.AES128
        : (typeof window !== 'undefined' && window.AES128 ? window.AES128 : null);
    } catch (e) { AES128 = null; }
  }

  const NCM_CORE_KEY = hexToBytes('687A4852416D736F356B496E62617857');
  const NCM_META_KEY = hexToBytes('2331346C6A6B5F215C5D2630553C2728');

  // ---- 字节工具（浏览器/Node 统一）----
  function hexToBytes(h) {
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
    return a;
  }
  function latin1(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }
  function u32le(u8, off) { return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0; }
  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64); const a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return a;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  function utf8(u8) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(u8);
    return Buffer.from(u8).toString('utf8');
  }
  function toNodeBuf(u8) { return (typeof Buffer !== 'undefined') ? Buffer.from(u8) : u8; }

  function aes128EcbDecrypt(buf, key) {
    if (nodeCrypto && typeof Buffer !== 'undefined') {
      const d = nodeCrypto.createDecipheriv('aes-128-ecb', Buffer.from(key), null);
      d.setAutoPadding(false);
      return Buffer.concat([d.update(Buffer.from(buf)), d.final()]);
    }
    if (!AES128) throw new Error('无可用 AES 实现（浏览器需先加载 aes128_ecb.js）');
    return AES128.aes128EcbDecrypt(buf instanceof Uint8Array ? buf : new Uint8Array(buf), key);
  }

  function stripPkcs7(b) {
    const p = b[b.length - 1];
    return (p >= 1 && p <= 16) ? b.subarray(0, b.length - p) : b;
  }

  function decodeNcmBuffer(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (latin1(buf.subarray(0, 8)) !== 'CTENFDAM') throw new Error('不是 NCM 文件');
    let o = 10;
    const keyLen = u32le(buf, o); o += 4;
    const kd = buf.subarray(o, o + keyLen); o += keyLen;
    const kdB = new Uint8Array(kd.length);
    for (let i = 0; i < kd.length; i++) kdB[i] = kd[i] ^ 0x64;
    let key = stripPkcs7(aes128EcbDecrypt(kdB, NCM_CORE_KEY));
    if (latin1(key.subarray(0, 17)) === 'neteasecloudmusic') key = key.subarray(17);

    const box = new Uint8Array(256);
    for (let i = 0; i < 256; i++) box[i] = i;
    let c = 0, last = 0, off = 0;
    for (let i = 0; i < 256; i++) {
      const sw = box[i];
      c = (sw + last + key[off]) & 0xff;
      off = (off + 1) % key.length;
      box[i] = box[c]; box[c] = sw; last = c;
    }

    // 元数据（歌名/歌手/专辑/封面），解不出来也不影响播放
    let meta = null;
    const metaLen = u32le(buf, o); o += 4;
    if (metaLen > 0) {
      const m = buf.subarray(o, o + metaLen); o += metaLen;
      const mm = new Uint8Array(m.length);
      for (let i = 0; i < m.length; i++) mm[i] = m[i] ^ 0x63;
      try {
        let dec = aes128EcbDecrypt(b64ToBytes(latin1(mm.subarray(22))), NCM_META_KEY);
        if (latin1(dec.subarray(0, 6)) === 'music:') dec = dec.subarray(6);
        meta = JSON.parse(utf8(stripPkcs7(dec)).replace(/\0+$/, ''));
      } catch (e) { meta = null; }
    }
    o += 4; // crc32
    o += 5; // gap
    const imgSize = u32le(buf, o); o += 4;
    o += imgSize; // 封面

    const audio = buf.subarray(o);
    const audioOut = new Uint8Array(audio.length);
    for (let i = 0; i < audio.length; i++) {
      const j = (i + 1) & 0xff;
      audioOut[i] = audio[i] ^ box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff];
    }
    let ext = 'mp3';
    const head4 = latin1(audioOut.subarray(0, 4));
    if (head4 === 'fLaC') ext = 'flac';
    else if (head4 === 'OggS') ext = 'ogg';
    else if (latin1(audioOut.subarray(4, 8)) === 'ftyp') ext = 'm4a';
    else if (head4 === 'RIFF') ext = 'wav';
    return { audio: toNodeBuf(audioOut), ext, meta };
  }

  return { decodeNcmBuffer, _internal: { NCM_CORE_KEY, NCM_META_KEY, AES128: !!AES128 } };
});
