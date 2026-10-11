# 叶诗音乐 · 手机端：如何拿到可安装/下载的 App

本工程在受限沙箱里无法真出 APK/IPA（无 Mac、无 Android SDK、无真机），但已交付**构建就绪**的工程 + 自动化出包流程。下面三种方式任选，最终都能在手机上装好「叶诗音乐」。

---

## 方式 A：PWA（最快，无需原生构建）

手机浏览器（Android Chrome / Edge、iOS Safari）直接「添加到主屏幕」即可当 App 用。

1. 构建静态产物：`npm install && npm run build`（产出 `dist/`）
2. 把 `dist/` 部署到任意静态托管（GitHub Pages、Netlify、或本机 `npx serve dist` 后用手机同 Wi-Fi 访问）
3. 手机打开网址 → 浏览器菜单「添加到主屏幕」→ 像普通 App 一样启动

> PWA 走浏览器，本地音乐访问受浏览器文件系统限制（Android Chrome 可用「选择文件夹」读本地音乐；iOS Safari 能力较弱）。想要完整本地曲库访问走方式 B/C 的原生壳。

---

## 方式 B：Android APK（本地一键构建）

前置：Node ≥ 18、JDK 17、Android SDK（含 `platform-34` 与 `build-tools;34.0.0`）、`ANDROID_HOME` 配好。

```bash
cd mobile
bash scripts/build-apk.sh        # macOS/Linux
# 或 Windows：
scripts\build-apk.bat
```

产出的 `mobile/android/app/build/outputs/apk/debug/app-debug.apk` 可直接 `adb install` 或拷到手机侧载安装（debug 无需签名）。

**发布签名（上架/正式分发）**：`RELEASE=1 bash scripts/build-apk.sh`，并在 `mobile/android/app/` 下放签名配置（见 `android/app/build.gradle` 的 `signingConfigs`）。

---

## 方式 C：GitHub Actions 自动出包（推荐，零本地环境）

把 `mobile/` 作为仓库（或把 `.github/workflows/build-android.yml` 移到仓库根 `.github/workflows/` 并删掉 workflow 里的 `working-directory: mobile`）：

1. push 一个 tag：`git tag v0.1.0 && git push --tags`
2. 或到仓库 Actions 页面手动点 **Build Android APK** → **Run workflow**
3. 跑完在 **Artifacts** 里下载 `yeshi-music-android`（即 `app-debug.apk`），侧载安装即可

---

## iOS

iOS 只能在 **macOS + Xcode** 构建（`cap add ios` 需要 Mac）：

```bash
cd mobile
npm install
npx cap add ios
npx cap sync ios
npx cap open ios      # Xcode 里选真机/模拟器 Run
```

---

## 权限说明（Android 10+ Scoped Storage）

扫描默认目录 `Music / Download / Music/Netease / Music/KuGou`。若扫描为空：
- 在系统设置给「所有文件访问」权限；或
- 修改 `src/core/scan.js` 的 `DEFAULT_DIRS` 增补你的音乐目录。

## 已验证

`npm run selfcheck`（Node 静态自检）25 项全绿，覆盖解密（ncm/qq）、歌词引擎、浏览器版 metadata 标签解析与透传、语义去重闭环；另有 `npm run integration-test`（端到端闭环）19 项全绿，用内存版 Capacitor + MockAudio 在 Node 真实跑通「扫描→解密→播放URL→歌词→去重」整链路。原生壳/真机表现需按上面步骤在本机或 CI 实跑确认。
