/* 手机端身份引擎桥：移植桌面端 core/identity_engine.js 的纯函数核心。
 *
 * 功能：把「不同来源、长得不一样」的同名歌曲归一，按
 *   硬身份（标题|歌手|专辑 三键全同）> 软身份（标题|歌手 同，专辑可能不一）
 * 合并为重复组，并在每组里按「音质 > 评分 > 播放次数 > 修改时间」挑最优版本。
 * 用途：个人本地曲库常有重复（下载版/网易云版/酷狗版），长期自用必须能识别并标注。
 *
 * 移植说明：
 *  - 只搬纯函数（norm/identityKey/softKey/quality/duplicateGroups/bestOf/analyze），
 *    不搬 signature/selfCheck（依赖 Node fs/crypto 读真实文件，WebView 无此能力）。
 *  - 全部只吃 track 对象上的字段，零浏览器/Node 专属依赖，可在 Node 下被 selfcheck 验证。
 *  - 输入 track 约定：{ name, title?, artist?, album?, format?/ext?, rating?, wmpPlayCount?, mtime? }
 *    手机端 enrich 时把 decrypt/meta 结果映射到这些字段即可。
 */
const PUNC = /[\s\-_–—·•・:;；'"“”‘’`~!！?？,.，。/\\|()[\]{}&*#+@$%^<>《》「」『』〔〕〈〉‥…、（）【】]/g;

/** 标题/歌手归一：去扩展名、分隔符、括号、feat 等尾巴 */
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\.(mp3|flac|wav|m4a|aac|ogg|wma|ape|ncm|aiff|alac)$/i, '')
    .replace(PUNC, '')
    .replace(/\b(feat|ft|remix|live|edit|version|mix|official)\b/g, '');
}

export function identityKey(t) {
  const title = norm(t.title || t.name);
  const artist = norm(t.artist || t.albumArtist);
  const album = norm(t.album);
  return `${title}|${artist}|${album}`;
}

export function softKey(t) {
  return `${norm(t.title || t.name)}|${norm(t.artist || t.albumArtist)}`;
}

/** 音质档位：重复组里挑「留哪个」用 */
export function quality(t) {
  const f = String(t.format || t.ext || t.name || '').toLowerCase();
  if (/flac|ape|alac|wav/.test(f)) return 3;
  if (/m4a|aac/.test(f)) return 2;
  if (/mp3|ogg|wma/.test(f)) return 1;
  return 0;
}

/** 重复组：exact=标题|歌手|专辑全同；soft=标题|歌手同（专辑可能不一致） */
export function duplicateGroups(tracks) {
  const exact = new Map(), soft = new Map();
  const tracks_ = Array.isArray(tracks) ? tracks : [];
  for (let i = 0; i < tracks_.length; i++) {
    const t = tracks_[i] || {};
    const a = identityKey(t), b = softKey(t);
    if (a.replace(/\|/g, '')) { if (!exact.has(a)) exact.set(a, []); exact.get(a).push(i); }
    if (b.replace(/\|/g, '')) { if (!soft.has(b)) soft.set(b, []); soft.get(b).push(i); }
  }
  const groups = [];
  const seen = new Set();
  for (const [k, arr] of exact) if (arr.length > 1) { groups.push({ type: 'exact', key: k, indices: arr, confidence: 0.98 }); arr.forEach(i => seen.add(i)); }
  for (const [k, arr] of soft) {
    if (arr.length <= 1) continue;
    const fresh = arr.filter(i => !seen.has(i));
    if (fresh.length > 1) groups.push({ type: 'soft', key: k, indices: fresh, confidence: 0.86 });
  }
  return groups;
}

/** 重复组里该留哪一首：音质 > 用户评分 > 播放次数 > 修改时间 */
export function bestOf(tracks, indices) {
  const arr = (indices || []).slice().sort((a, b) => {
    const A = tracks[a] || {}, B = tracks[b] || {};
    return (quality(B) - quality(A)) || ((B.rating || 0) - (A.rating || 0))
      || ((B.wmpPlayCount || 0) - (A.wmpPlayCount || 0)) || ((B.mtime || 0) - (A.mtime || 0));
  });
  return arr[0];
}

/** 曲库分析：重复组 + 建议保留/删除下标 + 歌手/专辑计数 */
export function analyze(tracks) {
  const tracks_ = Array.isArray(tracks) ? tracks : [];
  const groups = duplicateGroups(tracks_);
  const suggestions = [];
  for (const g of groups) {
    const keep = bestOf(tracks_, g.indices);
    suggestions.push({
      type: g.type, confidence: g.confidence, keep, key: g.key,
      remove: g.indices.filter(i => i !== keep), indices: g.indices,
    });
  }
  const artists = new Map(), albums = new Map();
  tracks_.forEach((t, i) => {
    const a = String((t && t.artist) || '未知歌手').trim();
    const al = String((t && t.album) || '未知专辑').trim();
    if (!artists.has(a)) artists.set(a, []); artists.get(a).push(i);
    const ak = `${norm(a)}|${norm(al)}`;
    if (!albums.has(ak)) albums.set(ak, []); albums.get(ak).push(i);
  });
  return {
    trackCount: tracks_.length,
    duplicateGroups: groups.length,
    duplicateTracks: groups.reduce((n, g) => n + g.indices.length, 0),
    suggestions,
    artistCount: artists.size,
    albumCount: albums.size,
  };
}

/** 便捷：给扫描结果打上重复标记。返回带 _dup 标注的新数组（不修改原对象）。
 *  track 需含 { name, title?, artist?, album?, format? } 等；返回的 track 增加：
 *    _dup: boolean            是否为重复组中的非首选
 *    _dupKeep: boolean        是否为重复组建议保留版本
 *    _dupGroup: string|null   重复组 key
 */
export function annotateDuplicates(tracks) {
  const out = (tracks || []).map(t => Object.assign({}, t));
  const res = analyze(out);
  for (const s of res.suggestions) {
    const keep = s.keep;
    for (const i of s.indices) {
      out[i]._dupGroup = s.key;
      if (i === keep) out[i]._dupKeep = true;
      else out[i]._dup = true;
    }
  }
  return out;
}

export { PUNC };
