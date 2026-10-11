/* 本地音乐扫描（Capacitor Filesystem）
 * 感知平台差异：
 *  - 原生平台（Android/iOS）Filesystem.readFile 返回 base64 字符串
 *  - Web/PWA 平台返回 Blob/ArrayBuffer
 * 统一转成 { name, bytes:Uint8Array } 交给解密桥。
 * 说明：本机 Node 环境无法跑真机/模拟器验证，以下为按 Capacitor 官方 API 编写的标准用法，
 *       真机步骤见 README「真机验证」。
 */
import { Filesystem, Directory } from '@capacitor/filesystem';
import { isMusicExtension } from './decrypt-bridge.js';

export { isMusicExtension };

function b64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64); const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// 常见音乐目录（Android 外部存储相对路径）。Android 10+ Scoped Storage 下，
// 用户音乐通常在 Music/ 或 Download/，部分机型需用户授权「所有文件访问」。
export const DEFAULT_DIRS = ['Music', 'Download', 'Music/Netease', 'Music/KuGou'];

// 扫描单个目录（递归）。dir 为 Filesystem 相对路径；dirType 默认 ExternalStorage
export async function scanDir(dir, dirType = Directory.ExternalStorage, recursive = true, out = []) {
  let entries;
  try {
    const res = await Filesystem.readdir({ path: dir, directory: dirType });
    entries = res.files;
  } catch (e) {
    return out; // 目录不存在/无权限，静默跳过
  }
  for (const f of entries) {
    const full = dir ? dir.replace(/\/$/, '') + '/' + f.name : f.name;
    if (f.type === 'directory') {
      if (recursive) await scanDir(full, dirType, true, out);
    } else if (isMusicExtension(f.name)) {
      out.push({ name: f.name, path: full, directory: dirType });
    }
  }
  return out;
}

// 读取一个音乐文件的字节
export async function readFileBytes(path, dirType = Directory.ExternalStorage) {
  const res = await Filesystem.readFile({ path, directory: dirType });
  if (typeof res.data === 'string') return b64ToBytes(res.data);          // 原生平台
  if (res.data instanceof Blob) return new Uint8Array(await res.data.arrayBuffer()); // web
  if (res.data instanceof ArrayBuffer) return new Uint8Array(res.data);
  if (Array.isArray(res.data)) return new Uint8Array(res.data);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(res.data)) return new Uint8Array(res.data);
  throw new Error('无法识别的 Filesystem 返回类型');
}

// 便捷：扫描多个默认目录并去重
export async function scanLibrary(dirs = DEFAULT_DIRS, dirType = Directory.ExternalStorage) {
  const all = [];
  for (const d of dirs) await scanDir(d, dirType, true, all);
  const seen = new Set();
  return all.filter(it => {
    const k = it.path + '|' + it.name;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}
