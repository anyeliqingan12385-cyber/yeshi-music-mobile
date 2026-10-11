/* 播放器封装：把解密后的音频喂给 <audio>
 * 解密是 CPU 密集的同步操作，调用方负责在拿到 {format,bytes} 后调用 decryptedToObjectURL
 * 生成临时 URL 再 load。播放本身用原生 HTMLAudioElement，跨 Android/iOS WebView 通用。
 */
import { decryptedToObjectURL } from './decrypt-bridge.js';

export class Player {
  constructor() {
    this.audio = new Audio();
    this._url = null;
    this.meta = null;
  }

  // dec: decryptFile 的返回值（含 format/bytes/meta）
  load(dec) {
    this.unload();
    this.meta = dec.meta || { musicName: dec.name, artist: '', album: '' };
    const url = decryptedToObjectURL(dec);
    if (!url) throw new Error('当前环境无法生成音频 URL（需浏览器/WebView）');
    this._url = url;
    this.audio.src = url;
    return url;
  }

  unload() {
    if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  play() { return this.audio.play(); }
  pause() { this.audio.pause(); }
  seek(t) { this.audio.currentTime = t; }

  get duration() { return this.audio.duration || 0; }
  get currentTime() { return this.audio.currentTime || 0; }
  get paused() { return this.audio.paused; }

  on(event, cb) { this.audio.addEventListener(event, cb); }
  off(event, cb) { this.audio.removeEventListener(event, cb); }
}
