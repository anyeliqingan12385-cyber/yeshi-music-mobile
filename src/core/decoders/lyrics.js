/* ============================================================================
 * LyricEngine（歌词引擎）—— 阶段 7
 * ----------------------------------------------------------------------------
 * 统一处理：LRC / KRC（酷狗逐字） / 内嵌标签里的伪 LRC / 带 offset 的变体。
 * 纯函数，无 Node 依赖，**渲染进程可以直接 <script src> 引**（见阶段 10）。
 * 目标：
 *   1. 不管词源是 WMP、酷狗 KRC、本地 .lrc 还是内嵌标签，出口都是同一份时间轴
 *   2. 偏移（offset）集中管理，桌面歌词/歌词窗口共享同一个值
 *   3. 渲染层只拿「此刻该显示哪一行」，不再各自写解析
 * ==========================================================================*/
'use strict';

/** '01:23.45' / '1:2:3.4' → ms */
function parseTime(s) {
  if (typeof s === 'number') return isFinite(s) ? s : NaN;
  const t = String(s == null ? '' : s).trim();
  if (!t) return NaN;
  const all = t.split(':');
  const n = all.length;            // 位数要在 pop() 之前数，否则 '01:23.45' 会把分当秒
  const last = all.pop();
  // '01:23.45' → 1*60 + 23.45；'1:2:3.4' → 1*3600 + 2*60 + 3.4
  let sec = 0;
  for (let i = 0; i < n - 1; i++) {
    sec += (parseFloat(all[i]) || 0) * Math.pow(60, n - 1 - i);
  }
  sec += parseFloat(last) || 0;
  return Math.round(sec * 1000);
}

/** 时间轴排序比较 */
function cmpLine(a, b) { return (a.time || 0) - (b.time || 0); }

/** 解析一行（LRC 一行一个时间戳；KRC 一行多个）。返回 [{time,text}] */
function parseLine(raw) {
  const line = String(raw == null ? '' : raw).replace(/\r$/, '');
  if (!line) return [];
  const re = /\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  const stamps = [];
  let m;
  while ((m = re.exec(line))) stamps.push({ t: parseTime(m[1]), idx: m.index, len: m[0].length });
  if (!stamps.length) {
    // 没有时间戳：整行当「歌词头之外的自由文本」忽略（原样保留在 text 里会被当成空行）
    return [];
  }
  const plain = line.replace(re, '').trim();
  if (stamps.length === 1) return [{ time: stamps[0].t, text: plain }];
  // 多个时间戳：KRC 是逐字词（词块夹在时间戳之间），普通 LRC 是重复行
  // （两件事都兼容：切片为空时回退整行文本）
  return stamps.map((s, i) => {
    const next = stamps[i + 1];
    const from = s.idx + s.len;
    const to = next ? next.idx : line.length;
    const slice = line.slice(from, to).trim();
    return { time: s.t, text: slice || plain };
  });
}

/**
 * 去掉 KRC 的逐字时间戳块，转成普通 LRC 行（用于列表/复制）
 * 要去掉两类：① 标准时间块 [00:10.00] ② 逐字词块 [1,2]（酷狗把每个词的起止秒/权重写这种格式）
 */
function krcToText(line) {
  return String(line == null ? '' : line)
    .replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '')
    .replace(/\[\d{1,4},\s*\d{1,4}\]/g, '')
    .trim();
}

/**
 * 解析整段歌词
 * @param {string} text
 * @returns {{lines:Array<{time:number,text:string}>, meta:object, format:'krc'|'lrc'|'plain'|''}}
 */
function parse(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const meta = { offset: 0, title: '', artist: '', album: '', by: '' };
  if (!src.trim()) return { lines: [], meta, format: '' };

  const lines = [];
  const rawLines = src.split(/\r?\n/);
  let krc = false;

  for (const rl of rawLines) {
    // KRC 的标志是「一行里挂了不止一个时间轴」（逐字词的起止都标着时间），
    // 而不是「切出来的文本为空」——后者是普通 LRC 的纯间奏标记 [02:00.00]，两者要分清。
    if ((rl.match(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g) || []).length > 1) krc = true;
    const parsed = parseLine(rl);
    if (parsed.length) {
      for (const p of parsed) {
        if (p.text) lines.push({ time: p.time, text: p.text });
        else {
          // 空文本行只有两种情况：① 纯间奏标记（[02:00.00]）② KRC 逐字行的收尾块。
          // 只有「一行里本来就有多个时间戳、切片后还剩空」才敢认 KRC，
          // 否则像 [02:00.00] 这种普通 LRC 的间奏标记会被整个曲库误判成 KRC。
          if (parsed.length > 1) krc = true;
        }
      }
      continue;
    }
    // 不含时间戳：可能是 [ti:] 元信息行
    const mm = rl.match(/^\[(ti|ar|al|by|offset|re|ve|kana|length)\s*:\s*(.*?)\]\s*$/i);
    if (mm) {
      const k = mm[1].toLowerCase(), v = mm[2].trim();
      if (k === 'offset') meta.offset = parseInt(v, 10) || 0;      // 通常正负 100ms 为单位
      else if (k === 'ti') meta.title = v;
      else if (k === 'ar') meta.artist = v;
      else if (k === 'al') meta.album = v;
      else if (k === 'by') meta.by = v;
      continue;
    }
    if (rl.trim()) lines.push({ time: NaN, text: rl.trim() });
  }

  const timed = lines.filter(l => isFinite(l.time)).sort(cmpLine);
  const untimed = lines.filter(l => !isFinite(l.time));
  const format = timed.length ? (krc ? 'krc' : 'lrc') : (untimed.length ? 'plain' : '');
  return { lines: timed, untimed, meta, format };
}

/**
 * 施加偏移后得到最终时间轴
 * @param {Array} lines
 * @param {number} offsetMs 正值=歌词延后（用户觉得唱得早时调正）
 */
function withOffset(lines, offsetMs) {
  const o = Number(offsetMs) || 0;
  if (!o) return lines;
  return lines.map(l => ({ time: l.time + o, text: l.text }));
}

/**
 * 取 t 毫秒时刻该显示的行
 * @returns {{index:number, line:object|null, prev:object|null, percent:number}}
 */
function at(lines, tMs) {
  const arr = lines || [];
  const t = Number(tMs) || 0;
  let i = -1;
  // 二分：行已排序
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid].time || 0) <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (arr.length && (arr[0].time || 0) > t) i = -1;
  return {
    index: i,
    line: i >= 0 ? arr[i] : null,
    prev: i > 0 ? arr[i - 1] : null,
    percent: arr.length && i >= 0 ? Math.round((t - (arr[i].time || 0)) / Math.max(1, ((arr[i + 1] && arr[i + 1].time) || t) - (arr[i].time || 0)) * 100) : 0,
  };
}

/** 生成 LRC 文本（导出/保存用） */
function stringify(lines, meta) {
  const m = meta || {};
  const head = [];
  if (m.title) head.push(`[ti:${m.title}]`);
  if (m.artist) head.push(`[ar:${m.artist}]`);
  if (m.album) head.push(`[al:${m.album}]`);
  if (m.by) head.push(`[by:${m.by}]`);
  if (m.offset) head.push(`[offset:${m.offset}]`);
  const body = (lines || []).map(l => {
    const s = Math.max(0, Math.floor((l.time || 0) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `[${mm}:${ss}.00]${l.text}`;
  });
  return head.concat(body).join('\n');
}

/** 从文件名猜 歌名 - 歌手（词源缺失时兜底） */
function guessFromName(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_+]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const m = base.match(/^(.*?)\s+[-–—]\s+(.+)$/);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  return { title: base, artist: '' };
}

/** 简易相似度（用于「这首词的词源对不对」） */
function similarity(a, b) {
  const A = String(a || '').toLowerCase().replace(/[\s\-_()（）]/g, '');
  const B = String(b || '').toLowerCase().replace(/[\s\-_()（）]/g, '');
  if (!A || !B) return 0;
  if (A === B) return 1;
  const dp = new Array(B.length + 1);
  for (let j = 0; j <= B.length; j++) dp[j] = j;
  for (let i = 1; i <= A.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= B.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (A[i - 1] === B[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return Math.round((1 - dp[B.length] / Math.max(A.length, B.length)) * 100) / 100;
}

module.exports = {
  parse, parseLine, parseTime, withOffset, at, stringify, krcToText, guessFromName, similarity, cmpLine,
};
