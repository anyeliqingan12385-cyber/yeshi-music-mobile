/* 手机端应用逻辑：扫描本地曲库 → 列表 → 点击解密播放 → 歌词同步
 * 解密/播放/歌词全部委托给 core/*（decrypt-bridge / scan / player / lyric-bridge），本文件只管 UI 与编排。
 * 注意：扫描与 readFileBytes 依赖 Capacitor Filesystem，只在真机/模拟器的 WebView 中可用；
 *       本机 Node 环境无法运行本文件（selfcheck 也不 import 它）。
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { scanLibrary, readFileBytes } from './core/scan.js';
import { decryptFile, isEncryptedName } from './core/decrypt-bridge.js';
import { Player } from './core/player.js';
import { createMobileLyricEngine, getLyric, at, sidecarPath } from './core/lyric-bridge.js';
import { annotateDuplicates } from './core/identity-bridge.js';

export function initApp(root) {
  root.innerHTML = `
    <header class="app-header">
      <h1>叶诗音乐</h1>
      <button id="refresh" class="btn">刷新曲库</button>
    </header>
    <main class="track-list" id="trackList">
      <div class="hint">正在扫描本地音乐…</div>
    </main>
    <footer class="player" id="player" hidden>
      <div class="now-playing">
        <div class="np-title" id="npTitle">—</div>
        <div class="np-sub" id="npSub"></div>
      </div>
      <div class="lyric" id="lyric"><div class="lyric-hint">暂无歌词</div></div>
      <div class="progress"><div class="bar" id="bar"></div></div>
      <div class="time"><span id="cur">0:00</span><span id="dur">0:00</span></div>
      <div class="controls">
        <button id="playPause" class="btn play">▶</button>
      </div>
    </footer>
  `;

  const listEl = root.querySelector('#trackList');
  const playerEl = root.querySelector('#player');
  const player = new Player();
  const lyricEl = root.querySelector('#lyric');
  let tracks = [];
  let curLyric = null;     // 当前歌曲的歌词结果 { lines, ... }
  let sidecarDir = null;   // 当前歌曲所在目录（供同名 .lrc 查找闭包捕获）

  // 歌词引擎：移动端用内存缓存 + 解密时已抽出的内嵌歌词；同名 .lrc 走 Capacitor Filesystem
  const lyricEngine = createMobileLyricEngine({
    dir: '', // MVP 不落盘缓存（见 README TODO），仅会话内内存缓存
    readSidecar: (audioPath) => readSidecarLrc(sidecarDir, audioPath),
  });

  root.querySelector('#refresh').addEventListener('click', loadLibrary);

  async function loadLibrary() {
    listEl.innerHTML = '<div class="hint" id="scanHint">正在扫描本地音乐…</div>';
    try {
      const hint = listEl.querySelector('#scanHint');
      const files = await scanLibrary();
      if (!files.length) { listEl.innerHTML = '<div class="hint">未找到音乐文件</div>'; return; }
      // 解析每首的元数据（标题/歌手/专辑/格式），再做语义去重标注。
      // 不落盘、只在内存完成，解析失败（损坏/无权限）自动回退到文件名身份，不影响整体。
      const enriched = [];
      for (let i = 0; i < files.length; i++) {
        if (hint) hint.textContent = '正在解析曲库 ' + (i + 1) + ' / ' + files.length + '…';
        enriched.push(await enrichTrack(files[i]));
      }
      tracks = annotateDuplicates(enriched);
      renderList();
    } catch (e) {
      listEl.innerHTML = '<div class="hint err">扫描失败：' + (e && e.message || e) + '</div>';
    }
  }

  /** 单首轻量解析：读字节 → 解密/读标签 → 抽元数据。失败回退到文件名身份。 */
  async function enrichTrack(f) {
    const fallback = () => ({
      name: f.name, path: f.path, directory: f.directory,
      title: f.name, artist: '', album: '',
      format: (f.name.split('.').pop() || '').toLowerCase(),
      ext: (f.name.split('.').pop() || '').toLowerCase(),
      encrypted: isEncryptedName(f.name),
    });
    try {
      const bytes = await readFileBytes(f.path, f.directory);
      const dec = await decryptFile({ name: f.name, bytes });
      const m = dec.meta || {};
      const format = dec.format || (f.name.split('.').pop() || '').toLowerCase();
      return {
        name: f.name, path: f.path, directory: f.directory,
        title: m.musicName || m.title || f.name,
        artist: m.artist || '',
        album: m.album || '',
        format, ext: format,
        encrypted: !!dec.encrypted,
      };
    } catch (e) {
      return fallback();
    }
  }

  function renderList() {
    if (!tracks.length) { listEl.innerHTML = '<div class="hint">未找到音乐文件</div>'; return; }
    listEl.innerHTML = '';
    for (const f of tracks) {
      const enc = f.encrypted || isEncryptedName(f.name);
      const cls = 'track' + (enc ? ' encrypted' : '') + (f._dup ? ' dup' : '');
      const nameHtml = escapeHtml(f.title || f.name);
      let badges = '';
      if (enc) badges += '<span class="badge enc">加密</span>';
      if (f._dupKeep) badges += '<span class="badge keep">保留</span>';
      if (f._dup) badges += '<span class="badge dup">重复</span>';
      const sub = [f.artist, f.album].filter(Boolean).join(' · ');
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML =
        '<div class="t-main"><span class="t-name">' + nameHtml + '</span>' +
        (badges ? '<span class="badges">' + badges + '</span>' : '') + '</div>' +
        (sub ? '<div class="t-sub">' + escapeHtml(sub) + '</div>' : '');
      el.addEventListener('click', () => playTrack(f));
      listEl.appendChild(el);
    }
  }

  async function playTrack(f) {
    try {
      const bytes = await readFileBytes(f.path, f.directory);
      const dec = await decryptFile({ name: f.name, bytes });
      // ncm 内嵌歌词已在解密结果里（dec.lyric），登记后歌词引擎无需重解音频
      if (dec.lyric) lyricEngine.setEmbeddedLyric(f.path, dec.lyric);
      sidecarDir = f.directory; // 供闭包里的同名 .lrc 查找使用
      player.load(dec);
      playerEl.hidden = false;
      // 展示优先用扫描时已解析好的元数据（f.title/artist/album），dec.meta 兜底
      const m = dec.meta || {};
      const title = f.title || m.musicName || m.title || f.name;
      const artist = f.artist || m.artist || '';
      const album = f.album || m.album || '';
      const quality = (dec.metaRaw && dec.metaRaw.quality) || '';
      root.querySelector('#npTitle').textContent = title;
      root.querySelector('#npSub').textContent = [artist, album, quality].filter(Boolean).join(' · ');

      // 取歌词（按 manual→cache→sidecar→embedded→source 优先级；sidecar 为异步读取）
      const track = { trackId: f.path, path: f.path, title, artist, album, duration: 0 };
      curLyric = await getLyric(lyricEngine, track);
      renderLyric(curLyric);

      await player.play();
      updatePlayBtn();
    } catch (e) {
      if (typeof alert === 'function') alert('播放失败：' + (e && e.message || e));
    }
  }

  function renderLyric(res) {
    curLyric = res;
    if (!res || !res.found || !res.lines.length) {
      lyricEl.innerHTML = '<div class="lyric-hint">暂无歌词</div>';
      return;
    }
    let html = '<div class="lyric-src">来源：' + (res.sourceLabel || res.source) + (res.cached ? '（已缓存）' : '') + '</div>';
    for (let i = 0; i < res.lines.length; i++) {
      html += '<div class="lyric-line" data-i="' + i + '">' + escapeHtml(res.lines[i].text || '') + '</div>';
    }
    lyricEl.innerHTML = html;
    lyricEl.scrollTop = 0;
  }

  function highlightLyric(curMs) {
    if (!curLyric || !curLyric.found || !curLyric.lines.length) return;
    const hit = at(curLyric.lines, curMs);
    const idx = hit && hit.index >= 0 ? hit.index : -1;
    const prev = lyricEl.querySelector('.lyric-line.active');
    if (prev) prev.classList.remove('active');
    const el = idx >= 0 ? lyricEl.querySelector('.lyric-line[data-i="' + idx + '"]') : null;
    if (el) {
      el.classList.add('active');
      // 让当前行滚动到面板中部
      const target = el.offsetTop - lyricEl.clientHeight / 2 + el.clientHeight / 2;
      lyricEl.scrollTop = Math.max(0, target);
    }
  }

  function fmt(t) { if (!isFinite(t) || t < 0) return '0:00'; const m = Math.floor(t / 60); const s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function updatePlayBtn() { root.querySelector('#playPause').textContent = player.paused ? '▶' : '❚❚'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  root.querySelector('#playPause').addEventListener('click', () => {
    if (player.paused) player.play().then(updatePlayBtn).catch(() => {});
    else player.pause();
    updatePlayBtn();
  });
  player.on('timeupdate', () => {
    const cur = player.currentTime, dur = player.duration;
    root.querySelector('#cur').textContent = fmt(cur);
    root.querySelector('#dur').textContent = fmt(dur);
    const bar = root.querySelector('#bar');
    if (dur) bar.style.width = (cur / dur * 100) + '%';
    highlightLyric(cur * 1000);
  });
  player.on('ended', updatePlayBtn);
  player.on('loadedmetadata', () => { root.querySelector('#dur').textContent = fmt(player.duration); });

  /** 读同目录同名 .lrc（仅真机 WebView 可用；文件不存在/出错返回 null） */
  async function readSidecarLrc(directory, audioPath) {
    try {
      const p = sidecarPath(audioPath);
      const r = await Filesystem.readFile({ path: p, directory: directory || undefined, encoding: Encoding.UTF8 });
      return typeof r.data === 'string' ? r.data : null;
    } catch (e) { return null; }
  }

  loadLibrary();
}
