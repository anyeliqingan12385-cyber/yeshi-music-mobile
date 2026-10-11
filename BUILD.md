# 叶诗音乐 · 手机端：如何拿到可安装/下载的 App

本工程在受限沙箱里无法真出 APK/IPA（无 Mac、无 Android SDK、无真机，且 `npm install` 在此沙箱被拦截），但已交付**构建就绪**的工程 + 自动化出包流程。本目录已 `git init` 并完成首次提交，CI 出包只需再加远程推送即可。下面三种方式任选，最终都能在手机上装好「叶诗音乐」。

---

## 方式 A：网页版 / PWA（最快，无需原生构建）

复用与原生端**完全相同**的解密/歌词/去重核心，只是文件来源改浏览器「选择文件夹」（`webkitdirectory`）。手机浏览器「添加到主屏幕」即装即用，**无需 Capacitor/SDK**。

1. 构建静态产物：`npm install && npm run build`（产出 `dist/`，含 `index.html`=原生端、`web.html`=网页版）
2. 把 `dist/` 部署到任意静态托管（GitHub Pages、Netlify、或本机 `npx serve dist` 后用手机同 Wi-Fi 访问）
3. 手机打开 `dist/web.html` 网址 → 浏览器菜单「添加到主屏幕」→ 像普通 App 一样启动 → 点「选择音乐文件夹」挑本地目录即可播放

> 网页版逻辑已通过 `npm run web-smoke`（14 项 Node 闭环）验证。浏览器文件系统限制：Android Chrome 可用「选择文件夹」读本地音乐（含子目录）；iOS Safari 对 `webkitdirectory` 支持较弱，iOS 上建议走方式 B/C 原生壳。

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

本目录已 `git init` 并完成首次提交，CI 工作流就在 `mobile/.github/workflows/build-android.yml`。只需：

1. 在 GitHub 新建一个空仓库，拿到 URL（如 `https://github.com/你/yeshi-music-mobile.git`）
2. 本地执行：
   ```bash
   git remote add origin <你的GitHub仓库URL>
   git branch -M main
   git push -u origin main
   ```
3. 到仓库 **Actions** 页面手动点 **Build Android APK** → **Run workflow**
4. 跑完在 **Artifacts** 里下载 `yeshi-music-android`（即 `app-debug.apk`），侧载安装即可

> 也可 `git tag v0.1.0 && git push --tags` 触发（若 workflow 配置了 tag 事件）。CI 云端自带 JDK17 + Android SDK，`npm install`/`cap add`/`gradlew assembleDebug` 全自动。

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

本机三件套 Node 自检全绿（共 **58 项**）：

- `npm run selfcheck` —— **25 项**：解密（ncm/qq）、歌词引擎、浏览器版 metadata 标签解析与透传、语义去重闭环。
- `npm run integration-test` —— **19 项**：用内存版 Capacitor + MockAudio 在 Node 真实跑通「扫描→解密→播放URL→歌词→去重」端到端整链路。
- `npm run web-smoke` —— **14 项**：复用与网页版 `src/web/main.js` 完全相同的核心，证明**网页形态**下「解密→播放URL→歌词→去重」同样可闭环。

> 以上均为 Node 静态/mock 闭环，不依赖真机；原生壳/真机表现需按上面步骤在本机或 CI 实跑确认（`npm install` 在本沙箱被拦截，故 `dist/` 与 APK 需在你自己的机器或 GitHub Actions 产出）。
