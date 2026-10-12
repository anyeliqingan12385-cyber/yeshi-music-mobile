/* 解密桥：手机端 Web 的统一解密入口
 * 直接复用桌面端 core 的纯 JS 解密核心（单一真相源），并做浏览器/Node 双环境兼容。
 * - 桌面端 Node 侧：import 拿到 CJS 默认导出
 * - 浏览器/WebView 侧：UMD 把 NcmDecrypt/QQDecrypt 挂到 window（兜底取 window）
 * decryptFile() 是纯逻辑（不碰浏览器 API），可在 Node 下被 selfcheck 验证；
 * decryptedToObjectURL() 依赖 Blob/URL，仅在浏览器侧调用。
 */
import NcmDecrypt from './decoders/ncmdecrypt.js';
import QQDecrypt from './decoders/qqdecrypt.js';
import * as MetadataBrowserNS from './decoders/metadata_browser.js';
const MetadataBrowser = MetadataBrowserNS.default || MetadataBrowserNS;
const { analyzeBytes } = MetadataBrowser;

function getNcm() { return NcmDecrypt || (typeof window !== 'undefined' && window.NcmDecrypt); }
function getQQ() { return QQDecrypt || (typeof window !== 'undefined' && window.QQDecrypt); }

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x && x.buffer) return new Uint8Array(x.buffer);
  if (Array.isArray(x)) return new Uint8Array(x);
  return new Uint8Array(x);
}

const ENCRYPT_EXT = ['ncm', 'mflac', 'mgg', 'mgg1', 'mflac0', 'qmcflac', 'qmcogg', 'qmc0', 'qmc2', 'qmc3', 'bkcmp3', 'bkcflac', 'tkm', 'qmdl'];

export function isEncryptedName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'ncm') return true;
  const QQ = getQQ();
  return !!(QQ && QQ.isQQEncryptedExt(ext));
}
export function isMusicExtension(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ['mp3', 'flac', 'ogg', 'oga', 'm4a', 'wav', ...ENCRYPT_EXT].includes(ext);
}

// file: { name:string, bytes:Uint8Array } → 解密结果 { format, bytes, meta?, method?, name, lyric?, metaRaw? }
export async function decryptFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const Ncm = getNcm();
  const QQ = getQQ();
  if (ext === 'ncm' && Ncm) {
    const r = Ncm.decodeNcmBuffer(file.bytes);
    // ncm 的 meta 是整段 JSON，含网易内嵌歌词（meta.lyric）。原样透传给上层做歌词来源，
    // 这样手机端拿到解密结果即可直接出词，无需再为歌词重解一次音频。
    const lyric = r.meta && typeof r.meta.lyric === 'string' ? r.meta.lyric : undefined;
    return { format: r.ext, bytes: toBytes(r.audio), meta: r.meta, lyric, name: file.name, encrypted: true };
  }
  if (QQ && QQ.isQQEncryptedExt(ext)) {
    const r = QQ.decryptBuffer(file.bytes, ext);
    // QQ 加密解密后是真实 flac/mp3/ogg，用浏览器版 metadata 取标签（歌名/歌手/专辑/内嵌歌词）
    const md = analyzeBytes(toBytes(r.data), { ext: r.format });
    const lyric = md && md.tags && typeof md.tags.lyric === 'string' ? md.tags.lyric : undefined;
    return { format: r.format, bytes: toBytes(r.data), method: r.method, meta: md ? md.tags : undefined, metaRaw: md, lyric, name: file.name, encrypted: true };
  }
  // 普通文件：直接读标签（flac/mp3/m4a/ogg/wav 等）
  const md = analyzeBytes(file.bytes, { ext });
  const lyric = md && md.tags && typeof md.tags.lyric === 'string' ? md.tags.lyric : undefined;
  return { format: ext, bytes: file.bytes, meta: md ? md.tags : undefined, metaRaw: md, lyric, name: file.name, encrypted: false };
}

const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' };

// 仅浏览器侧调用：把解密后的字节变成可喂给 <audio> 的 ObjectURL
export function decryptedToObjectURL(dec) {
  const mime = MIME[dec.format] || 'audio/mpeg';
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return null;
  return URL.createObjectURL(new Blob([dec.bytes], { type: mime }));
}

export { getNcm, getQQ };
