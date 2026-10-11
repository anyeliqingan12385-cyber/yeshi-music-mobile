/* 测试用 mock：替代 @capacitor/filesystem，由 ESM loader 重定向到本模块。
 * 内存文件树，挂在 globalThis.__MOCK_FS__（Map: 路径 -> {type:'directory'|'file', data?:base64}）。
 * 仅实现 scan.js / app.js 用到的 readdir / readFile，足以跑通「扫描→读字节」整段逻辑。
 */
function getFS() { return globalThis.__MOCK_FS__ || (globalThis.__MOCK_FS__ = new Map()); }
function normPath(p) { return (p || '').replace(/^\/+/, '').replace(/\/+$/, ''); }

export const Directory = { ExternalStorage: 'EXTERNAL_STORAGE', Data: 'DATA', Documents: 'DOCUMENTS', Cache: 'CACHE', Library: 'LIBRARY' };
export const Encoding = { UTF8: 'utf8', ASCII: 'ascii' };

export const Filesystem = {
  async readdir({ path }) {
    const fs = getFS();
    const dir = normPath(path);
    const prefix = dir ? dir + '/' : '';
    const children = new Map();
    for (const key of fs.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (!children.has(name)) children.set(name, fs.get(dir ? dir + '/' + name : name));
    }
    return { files: [...children.entries()].map(([name, node]) => ({ name, type: node.type })) };
  },
  async readFile({ path, encoding }) {
    const fs = getFS();
    const key = normPath(path);
    const node = fs.get(key);
    if (!node || node.type !== 'file') { const e = new Error('File does not exist: ' + key); e.code = 'ENOENT'; throw e; }
    if (encoding === 'utf8' || encoding === Encoding.UTF8) {
      return { data: Buffer.from(node.data, 'base64').toString('utf8') };
    }
    return { data: node.data }; // 原生平台返回 base64 字符串
  },
};

export default { Filesystem, Directory, Encoding };
