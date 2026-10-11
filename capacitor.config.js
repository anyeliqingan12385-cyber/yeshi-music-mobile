// Capacitor 配置：webDir 指向 vite build 输出（dist），原生壳通过 cap sync 注入。
export default {
  appId: 'com.yeshi.music',
  appName: '叶诗音乐',
  webDir: 'dist',
  server: {
    // Android 9+ 对 file:// 限制多，用 https scheme 的本地 server 加载更稳
    androidScheme: 'https'
  }
};
