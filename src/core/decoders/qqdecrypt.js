/*
 * core/qqdecrypt.js — QQ 音乐 QMC 加密格式解密器（.mflac / .mgg / .qmc* / .tkm / .bkc* 等）
 *
 * 算法严格移植自社区逆向实现（gongjiehong/QMCDecode 与 unlock-music 共用的同一套方案）：
 *   1) 内嵌密钥在文件尾部：移动端以 "QTag" 结尾；PC 端最后 4 字节(LE)是密钥长度。
 *   2) 密钥经 base64 解码后，用 Tencent TEA（delta=0x9e3779b9, 32 轮, CBC）解包出真实密钥。
 *   3) 真实密钥长度 > 300 → RC4 分段流密码；否则 → Map 位移异或密码。
 *   4) 若尾部读不到合法内嵌密钥（keySize >= 0x300 或非法），回退到 QQ 硬编码的 256 字节静态密钥
 *      （QMStaticCipher：mask(offset) = KEY[((offset%0x8000)^2 + 27) & 0xFF]，逐字节 XOR）。
 *
 * 本文件只做「纯解密」，不碰文件系统/缓存——缓存落盘由 main.js 的 decodeQq() 负责（仿 decodeNcm）。
 * UMD：Node 下 module.exports；浏览器/沙箱下挂到 window.QQDecrypt。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { global.QQDecrypt = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  // QQ 音乐硬编码的 256 字节静态密钥（与客户端一致；QMStaticCipher 用）
  const QMC_STATIC_KEY = [
    0x77, 0x48, 0x32, 0x73, 0xDE, 0xF2, 0xC0, 0xC8, 0x95, 0xEC, 0x30, 0xB2, 0x51, 0xC3, 0xE1, 0xA0,
    0x9E, 0xE6, 0x9D, 0xCF, 0xFA, 0x7F, 0x14, 0xD1, 0xCE, 0xB8, 0xDC, 0xC3, 0x4A, 0x67, 0x93, 0xD6,
    0x28, 0xC2, 0x91, 0x70, 0xCA, 0x8D, 0xA2, 0xA4, 0xF0, 0x08, 0x61, 0x90, 0x7E, 0x6F, 0xA2, 0xE0,
    0xEB, 0xAE, 0x3E, 0xB6, 0x67, 0xC7, 0x92, 0xF4, 0x91, 0xB5, 0xF6, 0x6C, 0x5E, 0x84, 0x40, 0xF7,
    0xF3, 0x1B, 0x02, 0x7F, 0xD5, 0xAB, 0x41, 0x89, 0x28, 0xF4, 0x25, 0xCC, 0x52, 0x11, 0xAD, 0x43,
    0x68, 0xA6, 0x41, 0x8B, 0x84, 0xB5, 0xFF, 0x2C, 0x92, 0x4A, 0x26, 0xD8, 0x47, 0x6A, 0x7C, 0x95,
    0x61, 0xCC, 0xE6, 0xCB, 0xBB, 0x3F, 0x47, 0x58, 0x89, 0x75, 0xC3, 0x75, 0xA1, 0xD9, 0xAF, 0xCC,
    0x08, 0x73, 0x17, 0xDC, 0xAA, 0x9A, 0xA2, 0x16, 0x41, 0xD8, 0xA2, 0x06, 0xC6, 0x8B, 0xFC, 0x66,
    0x34, 0x9F, 0xCF, 0x18, 0x23, 0xA0, 0x0A, 0x74, 0xE7, 0x2B, 0x27, 0x70, 0x92, 0xE9, 0xAF, 0x37,
    0xE6, 0x8C, 0xA7, 0xBC, 0x62, 0x65, 0x9C, 0xC2, 0x08, 0xC9, 0x88, 0xB3, 0xF3, 0x43, 0xAC, 0x74,
    0x2C, 0x0F, 0xD4, 0xAF, 0xA1, 0xC3, 0x01, 0x64, 0x95, 0x4E, 0x48, 0x9F, 0xF4, 0x35, 0x78, 0x95,
    0x7A, 0x39, 0xD6, 0x6A, 0xA0, 0x6D, 0x40, 0xE8, 0x4F, 0xA8, 0xEF, 0x11, 0x1D, 0xF3, 0x1B, 0x3F,
    0x3F, 0x07, 0xDD, 0x6F, 0x5B, 0x19, 0x30, 0x19, 0xFB, 0xEF, 0x0E, 0x37, 0xF0, 0x0E, 0xCD, 0x16,
    0x49, 0xFE, 0x53, 0x47, 0x13, 0x1A, 0xBD, 0xA4, 0xF1, 0x40, 0x19, 0x60, 0x0E, 0xED, 0x68, 0x09,
    0x06, 0x5F, 0x4D, 0xCF, 0x3D, 0x1A, 0xFE, 0x20, 0x77, 0xE4, 0xD9, 0xDA, 0xF9, 0xA4, 0x2B, 0x76,
    0x1C, 0x71, 0xDB, 0x00, 0xBC, 0xFD, 0x0C, 0x6C, 0xA5, 0x47, 0xF7, 0xF6, 0x00, 0x79, 0x4A, 0x11
  ];

  // 加密扩展名 → 输出标准格式（来自 QQ 客户端后缀映射表）
  const ENCRYPT_EXT = {
    mgg: 'ogg', mgg1: 'ogg',
    mflac: 'flac', mflac0: 'flac',
    qmcflac: 'flac', qmcogg: 'ogg',
    qmc0: 'mp3', qmc2: 'ogg', qmc3: 'mp3',
    bkcmp3: 'mp3', bkcflac: 'flac', tkm: 'm4a',
    // qmdl = QQ 音乐下载缓存格式，可能是 flac 也可能是 mp3/ogg，不预设格式，
    // 交给 sniff 按解密后的真实音频头判定（wanted=null → 接受任意合法头）。
    qmdl: null
  };

  function isQQEncryptedExt(ext) {
    if (!ext) return false;
    ext = String(ext).toLowerCase().replace(/^\./, '');
    return Object.prototype.hasOwnProperty.call(ENCRYPT_EXT, ext);
  }

  /* ---------------- 小工具 ---------------- */

  function u32le(b, o) { return ((b[o]) | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function u32be(b, o) { return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0); }
  function u32bytes(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  function asBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf)) return new Uint8Array(buf);
    if (Array.isArray(buf)) return Uint8Array.from(buf);
    throw new Error('unsupported input');
  }
  function b64decode(buf) {
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const o = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
    return o;
  }
  function b64encode(buf) {
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'latin1').toString('base64');
    return btoa(s);
  }

  // 嗅探解密结果是否为合法音频，返回格式或 null
  function sniff(buf) {
    if (buf.length >= 4 && buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return { format: 'flac' }; // fLaC
    if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return { format: 'mp3' }; // ID3
    if (buf.length >= 4 && buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return { format: 'ogg' }; // OggS
    if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return { format: 'wav' }; // RIFF
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return { format: 'm4a' }; // ftyp
    if (buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return { format: 'mp3' }; // MPEG 帧同步
    return null;
  }

  /* ---------------- Tencent TEA（密钥解包用）---------------- */

  class TeaCipher {
    constructor(key, rounds) {
      this.rounds = rounds || 64;
      this.delta = 0x9e3779b9;
      this.key0 = u32be(key, 0);
      this.key1 = u32be(key, 4);
      this.key2 = u32be(key, 8);
      this.key3 = u32be(key, 12);
    }
    _mixAdd(a, b) { return (a + b) >>> 0; }
    decrypt(src) {
      let v0 = u32be(src, 0), v1 = u32be(src, 4);
      let sum = (this.delta * (this.rounds / 2)) >>> 0;
      const half = this.rounds / 2;
      for (let i = 0; i < half; i++) {
        const m1 = (this._mixAdd((v0 << 4), this.key2) ^
          this._mixAdd(v0, sum) ^
          this._mixAdd((v0 >>> 5), this.key3)) >>> 0;
        v1 = (v1 - m1) >>> 0;
        const m2 = (this._mixAdd((v1 << 4), this.key0) ^
          this._mixAdd(v1, sum) ^
          this._mixAdd((v1 >>> 5), this.key1)) >>> 0;
        v0 = (v0 - m2) >>> 0;
        sum = (sum - this.delta) >>> 0;
      }
      return u32bytes(v0).concat(u32bytes(v1));
    }
    encrypt(src) {
      let v0 = u32be(src, 0), v1 = u32be(src, 4);
      let sum = 0;
      const half = this.rounds / 2;
      for (let i = 0; i < half; i++) {
        sum = (sum + this.delta) >>> 0;
        const m1 = (this._mixAdd((v1 << 4), this.key0) ^
          this._mixAdd(v1, sum) ^
          this._mixAdd((v1 >>> 5), this.key1)) >>> 0;
        v0 = (v0 + m1) >>> 0;
        const m2 = (this._mixAdd((v0 << 4), this.key2) ^
          this._mixAdd(v0, sum) ^
          this._mixAdd((v0 >>> 5), this.key3)) >>> 0;
        v1 = (v1 + m2) >>> 0;
      }
      return u32bytes(v0).concat(u32bytes(v1));
    }
  }

  /* ---------------- 三种流密码 ---------------- */

  class StaticCipher {
    constructor(key) { this.key = key; }
    mask(offset) {
      const temp = offset > 0x7FFF ? (offset % 0x7FFF) : offset;
      const index = ((temp * temp) + 27) & 0xFF;
      return this.key[index];
    }
    decrypt(data, offset) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data[i] ^ this.mask(offset + i);
      return out;
    }
  }

  class MapCipher {
    constructor(key) { this.key = key; }
    rotate(value, bits) {
      const r = (bits + 4) % 8;
      return ((value << r) | (value >> r)) & 0xff;
    }
    mask(offset) {
      const temp = offset > 0x7FFF ? (offset % 0x7FFF) : offset;
      const index = ((temp * temp) + 71214) & 0xFF;
      return this.rotate(this.key[index], index & 0x7);
    }
    decrypt(data, offset) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data[i] ^ this.mask(offset + i);
      return out;
    }
  }

  class RC4Cipher {
    constructor(originKey) {
      this.originKey = originKey;
      this.originKeyLength = originKey.length;
      const keyLength = originKey.length;
      const seedBox = new Uint8Array(keyLength);
      for (let i = 0; i < keyLength; i++) seedBox[i] = i & 0xff;
      let tempIndex = 0;
      for (let i = 0; i < keyLength; i++) {
        tempIndex = (seedBox[i] + tempIndex + originKey[i % keyLength]) % keyLength;
        const t = seedBox[i]; seedBox[i] = seedBox[tempIndex]; seedBox[tempIndex] = t;
      }
      this.seedBox = seedBox;
      this.hashValue = 1;
      const SEG = 0x1400;
      this.segmentSize = SEG;
      for (let i = 0; i < keyLength; i++) {
        const value = originKey[i];
        if (value === 0) continue;
        const nextHash = (this.hashValue * value) >>> 0;
        if (nextHash === 0 || nextHash <= this.hashValue) break;
        this.hashValue = nextHash;
      }
    }
    getSegmentKey(index) {
      const seed = this.originKey[index % this.originKeyLength];
      const resultValue = Math.floor(((this.hashValue / ((index + 1) * seed)) * 100));
      return resultValue % this.originKeyLength;
    }
    decrypt(data, offset) {
      const size = data.length;
      let toProcess = size, processed = 0, newOffset = offset;
      const result = new Uint8Array(data);
      const firstSegmentSize = 0x80;
      const segmentSize = this.segmentSize;
      const post = (len) => { toProcess -= len; processed += len; newOffset += len; return toProcess === 0; };
      if (newOffset < firstSegmentSize) {
        const len = Math.min(size, firstSegmentSize - newOffset);
        this._encodeFirst(result, 0, len, newOffset);
        if (post(len)) return result;
      }
      if (newOffset % segmentSize !== 0) {
        const len = Math.min(segmentSize - (newOffset % segmentSize), toProcess);
        this._encodeAll(result, processed, len, newOffset);
        if (post(len)) return result;
      }
      while (toProcess > segmentSize) {
        this._encodeAll(result, processed, segmentSize, newOffset);
        post(segmentSize);
      }
      if (toProcess > 0) this._encodeAll(result, processed, toProcess, newOffset);
      return result;
    }
    _encodeFirst(result, start, len, offset) {
      for (let i = 0; i < len; i++) result[start + i] ^= this.originKey[this.getSegmentKey(i + offset)];
    }
    _encodeAll(result, start, len, offset) {
      const newSeedBox = new Uint8Array(this.seedBox);
      const skipLength = (offset % this.segmentSize) + this.getSegmentKey(Math.floor(offset / this.segmentSize));
      let left = 0, right = 0;
      for (let index = -skipLength; index < len; index++) {
        left = (left + 1) % this.originKeyLength;
        right = (newSeedBox[left] + right) % this.originKeyLength;
        const t = newSeedBox[right]; newSeedBox[right] = newSeedBox[left]; newSeedBox[left] = t;
        if (index >= 0) {
          const sv = (newSeedBox[left] + newSeedBox[right]);
          result[start + index] ^= newSeedBox[sv % this.originKeyLength];
        }
      }
    }
  }

  /* ---------------- 密钥解包（base64 + Tencent TEA CBC）---------------- */

  function simpleMakeKey(seed, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = Math.floor(Math.abs(Math.tan(seed + i * 0.1)) * 100) & 0xff;
    }
    return out;
  }

  // 严格逆向自 QMCDecode 的 decryptTencentTea（标准 CBC，IV=0）
  function decryptTencentTea(inBuffer, teaKey) {
    if (inBuffer.length % 8 !== 0) throw new Error('tea: block not multiple of 8');
    if (inBuffer.length < 16) throw new Error('tea: too small');
    const tea = new TeaCipher(teaKey, 32);
    const saltLength = 2, zeroLength = 7;

    let tempBuffer = Uint8Array.from(tea.decrypt(inBuffer.subarray(0, 8)));
    const paddingLength = tempBuffer[0] & 0x7;
    const outputLength = inBuffer.length - 1 - paddingLength - saltLength - zeroLength;
    if (paddingLength + saltLength !== 8) throw new Error('tea: padding invalid');

    const outputBuffer = new Uint8Array(outputLength);
    let ivPrevious = new Uint8Array(8);
    let ivCruuent = Uint8Array.from(inBuffer.subarray(0, 8));
    let inBufferPosition = 8;
    let tempIndex = 1 + paddingLength;

    const cryptBlock = () => {
      ivPrevious = ivCruuent;
      ivCruuent = Uint8Array.from(inBuffer.subarray(inBufferPosition, inBufferPosition + 8));
      for (let j = 0; j < 8; j++) tempBuffer[j] ^= ivCruuent[j];
      tempBuffer = Uint8Array.from(tea.decrypt(tempBuffer));
      inBufferPosition += 8;
      tempIndex = 0;
    };

    // 跳过 salt
    let saltIndex = 1;
    while (saltIndex <= saltLength) {
      if (tempIndex < 8) { tempIndex++; saltIndex++; }
      else cryptBlock();
    }
    // 解密为原文
    let outPos = 0;
    while (outPos < outputLength) {
      if (tempIndex < 8) {
        outputBuffer[outPos] = tempBuffer[tempIndex] ^ ivPrevious[tempIndex];
        outPos++; tempIndex++;
      } else cryptBlock();
    }
    // 末尾 7 字节应为 0（校验）
    for (let i = 0; i < zeroLength; i++) {
      if (tempBuffer[tempIndex] !== ivPrevious[tempIndex]) throw new Error('tea: zero check failed');
    }
    return outputBuffer;
  }

  // 加密侧（仅测试用，构造合法内嵌密钥）：严格逆向 decryptTencentTea。
  // decrypt 的链式：T_i = dec(T_{i-1} XOR C_i)（T_{-1}=0），输出 P_i = T_i XOR C_{i-1}。
  // 反推得 C_0 = enc(P_0)；C_i = enc(P_i XOR C_{i-1}) XOR P_{i-1} XOR C_{i-2}（C_{-1}=0）。
  function encryptTencentTea(plaintext, teaKey) {
    const tea = new TeaCipher(teaKey, 32);
    const blocks = plaintext.length / 8;
    const out = new Uint8Array(plaintext.length);
    const zero8 = new Uint8Array(8);
    let Cprev = null;       // C_{i-1}
    let CprevPrev = zero8;  // C_{i-2}
    for (let b = 0; b < blocks; b++) {
      const p = plaintext.subarray(b * 8, b * 8 + 8);
      let x;
      if (b === 0) {
        x = tea.encrypt(p);
      } else {
        const px = new Uint8Array(8);
        for (let j = 0; j < 8; j++) px[j] = p[j] ^ Cprev[j];
        const e = tea.encrypt(px);
        const Pprev = plaintext.subarray((b - 1) * 8, (b - 1) * 8 + 8);
        x = new Uint8Array(8);
        for (let j = 0; j < 8; j++) x[j] = e[j] ^ Pprev[j] ^ CprevPrev[j];
      }
      out.set(x, b * 8);
      CprevPrev = Cprev || zero8;
      Cprev = x;
    }
    return out;
  }

  // rawKey(字节) → 真实密钥字节
  function deriveKey(rawKey) {
    const decoded = b64decode(rawKey);
    if (decoded.length < 16) throw new Error('key too short');
    const simpleKey = simpleMakeKey(106, 8);
    const teaKey = new Uint8Array(16);
    for (let i = 0; i < 8; i++) { teaKey[i * 2] = simpleKey[i]; teaKey[i * 2 + 1] = decoded[i]; }
    const inBuffer = decoded.subarray(8);
    const sub = decryptTencentTea(inBuffer, teaKey);
    const head = decoded.subarray(0, 8);
    const out = new Uint8Array(8 + sub.length);
    out.set(head, 0); out.set(sub, 8);
    return out;
  }

  /* ---------------- 主解密入口 ---------------- */

  // 内嵌密钥路径：返回解密后的音频字节（或 null 表示没找到合法内嵌密钥）
  function tryEmbedded(buffer) {
    const n = buffer.length;
    if (n < 12) return null;
    // 移动端：以 "QTag" 结尾
    if (buffer[n - 4] === 0x51 && buffer[n - 3] === 0x54 && buffer[n - 2] === 0x61 && buffer[n - 1] === 0x67) {
      const keySize = ((buffer[n - 8] << 24) | (buffer[n - 7] << 16) | (buffer[n - 6] << 8) | buffer[n - 5]) >>> 0;
      const audioSize = n - keySize - 8;
      if (keySize > 0 && keySize < n - 8 && audioSize > 0) {
        const rawKey = buffer.subarray(audioSize, audioSize + keySize);
        let comma = -1;
        for (let i = 0; i < rawKey.length; i++) if (rawKey[i] === 0x2C) { comma = i; break; }
        const keyBuf = comma >= 0 ? rawKey.subarray(0, comma) : rawKey;
        const dec = deriveKey(keyBuf);
        const audio = buffer.subarray(0, audioSize);
        return dec.length > 300 ? new RC4Cipher(dec).decrypt(audio, 0) : new MapCipher(dec).decrypt(audio, 0);
      }
    }
    // PC 端：最后 4 字节(LE) 是密钥长度
    const keySizeLE = u32le(buffer, n - 4);
    if (keySizeLE > 0 && keySizeLE < 0x300) {
      const audioSize = n - keySizeLE - 4;
      if (audioSize > 0) {
        const rawKey = buffer.subarray(audioSize, audioSize + keySizeLE);
        const dec = deriveKey(rawKey);
        const audio = buffer.subarray(0, audioSize);
        return dec.length > 300 ? new RC4Cipher(dec).decrypt(audio, 0) : new MapCipher(dec).decrypt(audio, 0);
      }
    }
    return null;
  }

  // buffer(字节) + ext → { format, data } 或抛错
  function decryptBuffer(buffer, ext) {
    const buf = asBytes(buffer);
    const wanted = ENCRYPT_EXT[String(ext || '').toLowerCase().replace(/^\./, '')] || null;
    const candidates = [];
    // 静态密钥（最常见，O(n)）
    candidates.push({ name: 'static', buf: new StaticCipher(QMC_STATIC_KEY).decrypt(buf, 0) });
    // 内嵌密钥
    try {
      const emb = tryEmbedded(buf);
      if (emb) candidates.push({ name: 'embedded', buf: emb });
    } catch (e) { /* deriveKey 失败说明不是内嵌密钥 */ }

    for (const c of candidates) {
      const s = sniff(c.buf);
      if (s && (!wanted || s.format === wanted || (wanted === 'ogg' && s.format === 'oga'))) {
        return { format: s.format, data: c.buf, method: c.name };
      }
    }
    // 两种都嗅探不到合法音频：退回静态结果（尽力而为）
    return { format: wanted || 'flac', data: candidates[0].buf, method: 'none-valid' };
  }

  return {
    QMC_STATIC_KEY, ENCRYPT_EXT, isQQEncryptedExt,
    decryptBuffer, sniff,
    // 以下导出仅供单元测试
    TeaCipher, StaticCipher, MapCipher, RC4Cipher,
    deriveKey, simpleMakeKey, decryptTencentTea, encryptTencentTea
  };
});
