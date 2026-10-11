/*
 * core/aes128_ecb.js — 纯 JS 实现的 AES-128-ECB 解密
 * ----------------------------------------------------------------------------
 * 为什么存在：浏览器/移动端（Capacitor WebView）的 Web Crypto API **不支持 ECB 模式**，
 * 而 ncm 解密必须用到 AES-128-ECB（key_data / 元数据段）。Node 侧仍走 require('crypto')，
 * 浏览器侧走这里的纯 JS 实现，保证 ncm 在两端都能解密。
 *
 * 约定：
 *   - 输入/输出/密钥一律 Uint8Array（与浏览器环境一致；Node 侧也传 Uint8Array）
 *   - 不做 padding 处理（AES 块密文可能带 PKCS7，由调用方 stripPkcs7）
 *   - 标准 FIPS-197；逆 S 盒由正向 S 盒程序化生成，避免手填出错
 * UMD：Node 下 module.exports；浏览器/沙箱下挂到 window.AES128。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { global.AES128 = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 正向 S 盒（标准 AES）
  const SBOX = new Uint8Array([
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
  ]);
  const SBOX_INV = new Uint8Array(256);
  for (let i = 0; i < 256; i++) SBOX_INV[SBOX[i]] = i;

  const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

  function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>>= 1;
    }
    return p;
  }

  function keyExpansion(key) {
    const Nk = 4, Nr = 10, Nb = 4;
    const w = new Uint8Array(4 * Nb * (Nr + 1));
    for (let i = 0; i < 16; i++) w[i] = key[i];
    for (let i = Nk; i < Nb * (Nr + 1); i++) {
      let t0 = w[(i - 1) * 4], t1 = w[(i - 1) * 4 + 1], t2 = w[(i - 1) * 4 + 2], t3 = w[(i - 1) * 4 + 3];
      if (i % Nk === 0) {
        // RotWord
        const a = t0, b = t1, c = t2, d = t3;
        t0 = b; t1 = c; t2 = d; t3 = a;
        // SubWord
        t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
        t0 ^= RCON[(i / Nk) - 1];
      } else if (Nk > 6 && i % Nk === 4) {
        t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
      }
      w[i * 4]     = w[(i - Nk) * 4]     ^ t0;
      w[i * 4 + 1] = w[(i - Nk) * 4 + 1] ^ t1;
      w[i * 4 + 2] = w[(i - Nk) * 4 + 2] ^ t2;
      w[i * 4 + 3] = w[(i - Nk) * 4 + 3] ^ t3;
    }
    return w;
  }

  function addRoundKey(s, w, round) {
    const base = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= w[base + i];
  }
  function invSubBytes(s) { for (let i = 0; i < 16; i++) s[i] = SBOX_INV[s[i]]; }
  function invShiftRows(s) {
    const t = s.slice();
    for (let c = 0; c < 4; c++) {
      s[c * 4 + 1] = t[((c + 3) % 4) * 4 + 1];
      s[c * 4 + 2] = t[((c + 2) % 4) * 4 + 2];
      s[c * 4 + 3] = t[((c + 1) % 4) * 4 + 3];
    }
  }
  function invMixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a = s[i], b = s[i + 1], cc = s[i + 2], d = s[i + 3];
      s[i]     = gmul(a, 14) ^ gmul(b, 11) ^ gmul(cc, 13) ^ gmul(d, 9);
      s[i + 1] = gmul(a, 9)  ^ gmul(b, 14) ^ gmul(cc, 11) ^ gmul(d, 13);
      s[i + 2] = gmul(a, 13) ^ gmul(b, 9)  ^ gmul(cc, 14) ^ gmul(d, 11);
      s[i + 3] = gmul(a, 11) ^ gmul(b, 13) ^ gmul(cc, 9)  ^ gmul(d, 14);
    }
  }

  function decryptBlock(block, w) {
    const Nr = 10;
    const s = block.slice();
    addRoundKey(s, w, Nr);
    for (let r = Nr - 1; r >= 1; r--) {
      invShiftRows(s);
      invSubBytes(s);
      addRoundKey(s, w, r);
      invMixColumns(s);
    }
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, w, 0);
    return s;
  }

  function aes128EcbDecrypt(input, key) {
    const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key);
    if (keyBytes.length !== 16) throw new Error('AES-128 需要 16 字节密钥，收到 ' + keyBytes.length);
    const w = keyExpansion(keyBytes);
    const out = new Uint8Array(input.length);
    for (let off = 0; off + 16 <= input.length; off += 16) {
      const dec = decryptBlock(input.subarray(off, off + 16), w);
      out.set(dec, off);
    }
    return out;
  }

  return { aes128EcbDecrypt, keyExpansion, decryptBlock, gmul, SBOX, SBOX_INV };
});
