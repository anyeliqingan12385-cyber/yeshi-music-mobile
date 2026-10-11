/* 网页版入口（无需原生壳 / 无需 @capacitor）：用 <input type=file webkitdirectory> 选音乐文件夹，
 * 复用与手机原生端完全相同的核心（decrypt-bridge / player / lyric-bridge / identity-bridge），
 * 因此「解密→播放→歌词→去重」逻辑与原生端单一真相源、已被同一批测试覆盖。
 *
 * 与手机原生端的唯一区别：文件来源用浏览器 File API 代替 Capacitor Filesystem。
 * 构建：npm run build（vite 同时产出 index.html=原生端、web.html=网页端，二者共用 core）。
 */
import '../style.css';
import { decryptFile, isEncryptedName, isMusicExtension, decryptedToObjectURL } from '../core/decrypt-bridge.js';
import { Player } from '../core/player.js';
import { createMobileLyricEngine, getLyric, sidecarPath } from '../core/lyric-bridge.js';
import { annotateDuplicates } from '../core/identity-bridge.js';

const root = document.getElementById('app');
const picker = document.getElementById('picker');
const hint = document.getElementById('hint');
const listEl = document.getElementById('list');
const npTitle = document.getElementById('npTitle');
const npSub = document.getElementById('npSub');
const lyricEl = document.getElementById('lyric');

const player = new Player();
const lyricEngine = createMobileLyricEngine({
  readSidecar: (p) => readSidecarLrc(p),
});

// 选中的文件：relativePath -> File；.lrc 单独建索引便于同名歌词查找
let audioFiles = [];   // [{ path, file }]
let lrcMap = new Map(); // sidecarPath -> File

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setHint(t) { hint.innerHTML = t; }

function readSidecarLrc(audioPath) {
  const f = lrcMap.get(sidecarPath(audioPath));
  if (!f) return null;
  return f.text(); // 由下面的读取逻辑填充
}

async function onPick(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) { setHint('未选择任何文件'); return; }
  audioFiles = [];
  lrcMap = new Map();
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    const lower = path.toLowerCase();
    if (lower.endsWith('.lrc')) { lrcMap.set(path, f); continue; }
    if (isMusicExtension(path)) audioFiles.push({ path, file: f });
  }
  if (!audioFiles.length) { setHint('所选文件夹里没有音乐文件（支持 ncm/flac/mp3/m4a/ogg/wav 及 QQ 加密格式）'); return; }
  await loadLibrary();
}

async function loadLibrary() {
  setHint('正在解密并解析 ' + audioFiles.length + ' 个文件…');
  const tracks = [];
  for (const { path, file } of audioFiles) {
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const dec = await decryptFile({ name: path, bytes });
      const m = dec.meta || {};
      const title = m.musicName || m.title || path.split('/').pop();
      const artist = m.artist || '';
      const album = m.album || '';
      tracks.push({ name: path, path, title, artist, album, format: dec.format, encrypted: dec.encrypted, _dec: dec });
    } catch (err) {
      tracks.push({ name: path, path, title: path.split('/').pop(), artist: '', album: '', format: '', encrypted: false, _err: String(err && err.message || err) });
    }
  }
  const annotated = annotateDuplicates(tracks.map(({ _dec, ...t }) => t));
  // 把标注合并回带 _dec 的 track
  for (let i = 0; i < tracks.length; i++) {
    tracks[i]._dup = annotated[i] && annotated[i]._dup;
    tracks[i]._dupKeep = annotated[i] && annotated[i]._dupKeep;
    tracks[i]._dupGroup = annotated[i] && annotated[i]._dupGroup;
  }
  renderList(tracks);
  const dup = tracks.filter((t) => t._dup).length;
  setHint('共 ' + tracks.length + ' 首' + (dup ? '，已标出 ' + dup + ' 个重复版本（保留音质更高者）' : '') + '。点歌即可播放。');
}

let currentTracks = [];
function renderList(tracks) {
  currentTracks = tracks;
  listEl.innerHTML = '';
  if (!tracks.length) { listEl.innerHTML = '<div class="hint">没有可播放的音乐</div>'; return; }
  for (const t of tracks) {
    const el = document.createElement('div');
    el.className = 'track' + (t.encrypted ? ' encrypted' : '');
    el.innerHTML =
      '<span class="t-name">' + escapeHtml(t.title || t.name) + '</span>' +
      (t.artist ? '<span class="t-sub">' + escapeHtml(t.artist) + (t.album ? ' · ' + escapeHtml(t.album) : '') + '</span>' : '') +
      (t.encrypted ? '<span class="badge">加密</span>' : '') +
      (t._dupKeep ? '<span class="badge keep">保留</span>' : '') +
      (t._dup ? '<span class="badge dup">重复</span>' : '');
    el.addEventListener('click', () => playTrack(t));
    listEl.appendChild(el);
  }
}

let curLyric = null;
async function playTrack(t) {
  if (t._err) { setHint('该文件解密失败：' + t._err); return; }
  const dec = t._dec;
  if (!dec) { setHint('缺少解密结果'); return; }
  player.load(dec);
  playerEl().hidden = false;
  npTitle.textContent = t.title || t.name;
  npSub.textContent = [t.artist, t.album, (dec.metaRaw && dec.metaRaw.quality) || ''].filter(Boolean).join(' · ');

  // 内嵌歌词先登记（ncm 的 meta.lyric），再按优先级取词
  if (dec.lyric) lyricEngine.setEmbeddedLyric(t.path, dec.lyric);
  curLyric = await getLyric(lyricEngine, { trackId: t.path, path: t.path, title: t.title, artist: t.artist }, {});
  renderLyric(curLyric);

  try { await player.play(); } catch (e) { /* 自动播放可能被拦截，用户可手动点 */ }
}

function playerEl() { return document.getElementById('player'); }

function renderLyric(ly) {
  if (!ly || !ly.lines || !ly.lines.length) { lyricEl.innerHTML = '<div class="hint">暂无歌词</div>'; return; }
  lyricEl.innerHTML = ly.lines.map((l) => '<div class="lyric-line">' + escapeHtml(l.text) + '</div>').join('');
  // 简单按时间轴高亮
  player.on('timeupdate', () => {
    const idx = ly.at ? ly.at(player.currentTime * 1000) : -1;
    const lines = lyricEl.querySelectorAll('.lyric-line');
    lines.forEach((n, i) => n.classList.toggle('active', i === idx));
    if (idx >= 0 && lines[idx]) lines[idx].scrollIntoView({ block: 'center' });
  });
}

picker.addEventListener('change', onPick);
const btnPlay = document.getElementById('btnPlay');
if (btnPlay) btnPlay.addEventListener('click', () => {
  if (player.paused) player.play().catch(() => {}); else player.pause();
});
// 暴露给自测（web-smoke 通过 mock 的 document 调用核心，无需真实点击）
window.__yeshiWeb = { decryptFile, isEncryptedName, isMusicExtension, decryptedToObjectURL, annotateDuplicates, createMobileLyricEngine, getLyric, sidecarPath, Player };
