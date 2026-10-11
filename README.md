# 叶诗音乐 · 手机端（Android / iOS）

本地音乐播放器，能扫手机里的音乐文件、解密网易云 `.ncm` 与 QQ 音乐加密格式（`.mflac/.mgg/.qmc*/.tkm/.kgg` 等）并播放。技术栈 **Capacitor + 原生 Web（Vite）**，双平台共用一套代码。

## 核心思路：复用桌面端的解密引擎，不重写算法

桌面端（`E:/1YINYUE/core/`）最值钱的两块——**解密算法**与**匹配/歌词引擎**——本身就是纯 JS，手机端直接复用，**单一真相源**，不另写一份。

| 模块 | 手机端处置 | 说明 |
|------|-----------|------|
| `core/qqdecrypt.js` | ✅ 直接复用 | 纯 JS（TEA/RC4/XOR 全自实现，无 Node 依赖），UMD 浏览器可用 |
| `core/ncmdecrypt.js` | ✅ 改造后复用 | 原仅 Node `crypto`；已加**双路径 AES**：Node 走 `crypto`，浏览器/WebView 走新增的 `core/aes128_ecb.js` 纯 JS 实现（Web Crypto 不支持 ECB） |
| `core/aes128_ecb.js` | 🆕 新增 | 纯 JS AES-128-ECB 解密（标准 FIPS-197），用于 ncm 在浏览器侧的解密 |
| `core/lyricengine.js` | ✅ 已接入 | 经 `src/core/lyric-bridge.js` 封装，注入移动端 `fsx`/`readSidecar`/`setEmbeddedLyric`；ncm 内嵌歌词在解密时登记、同名 `.lrc` 走 Capacitor Filesystem |
| `core/metadata_browser.js` | 🆕 新增 | `core/metadata.js` 的**纯 Uint8Array 移植**（去 `fs`/`path`、去 Node `Buffer`，改用 `DataView`+`TextDecoder`），浏览器/WebView 可用；普通/QQ 文件的歌名/歌手/专辑/标签歌词经 decrypt-bridge 透传 |
| `core/identity-bridge.js` | 🆕 新增 | 移植桌面端 `core/identity_engine.js` 的**纯函数去重核心**（`norm/identityKey/softKey/quality/duplicateGroups/bestOf/analyze/annotateDuplicates`），零浏览器/Node 依赖，用于曲库语义去重标注（同歌多版本挑音质最高者保留） |
| `main.js` / `preload.js` / `renderer` | 🔄 重做 | Electron 壳与桌面 UI 不适用，手机端用 `src/` 的响应式 Web UI 重做 |
| `storage.js` / `database.js` | 🔄 替换 | Node/electron 专属，手机端用 Capacitor Preferences/Filesystem 替代 |
| `web.html` / `src/web/main.js` | 🆕 新增 | **网页版入口**：用 `<input type=file webkitdirectory>` 选本地文件夹，复用与原生端**完全相同**的核心（decrypt-bridge/player/lyric-bridge/identity-bridge），**无需原生壳**即可在手机浏览器「添加到主屏幕」当 App 用 |

## 目录结构

```
mobile/
├── package.json          # 依赖与脚本（cap add/sync、selfcheck、integration-test、web-smoke、build）
├── vite.config.js        # Web 构建（允许 import 上级 core；双入口 index.html=原生端、web.html=网页版）
├── capacitor.config.js   # Capacitor 配置（webDir=dist）
├── index.html            # 原生端入口（Capacitor 壳加载）
├── web.html              # 网页版入口（浏览器/直接部署，无需原生壳）
├── src/
│   ├── main.js           # 原生端入口（检测运行环境：无 Capacitor 时自动跳转到网页版 web.html）
│   ├── app.js            # 原生端 UI 编排：扫描→列表→点击解密播放→歌词同步→去重标注
│   ├── web/main.js       # 网页版 UI 编排：选文件夹→解密→播放→歌词→去重（复用同一批核心）
│   ├── style.css         # 响应式样式（含 safe-area）
│   ├── service-worker.js # ⚠️ 已废弃（逻辑迁至 public/sw.js），仅占位文件，不被任何入口引用
│   ├── core/
│   │   ├── decrypt-bridge.js  # 统一解密入口（路由 ncm/qq/普通），透传 ncm 内嵌歌词 + 标签元数据
│   │   ├── lyric-bridge.js    # 歌词引擎移动端封装（内嵌歌词登记 + 同名 .lrc）
│   │   ├── identity-bridge.js # 曲库语义去重纯函数（标题|歌手|专辑 三键归一 + 重复组/推荐保留）
│   │   ├── scan.js            # Capacitor Filesystem 扫描与读文件
│   │   ├── player.js          # HTMLAudioElement 封装，喂 Blob URL
│   │   └── decoders/         # 从桌面端 vendor 的纯 JS 解密/歌词核心（ncmdecrypt/qqdecrypt/metadata_browser/lyricengine/lyrics/aes128_ecb，CJS；自带 package.json 标 commonjs），使 mobile 仓库自包含、可独立 CI 出包
│   └── tools/
│       ├── selfcheck.js       # Node 静态自检（解密 + 歌词 + 浏览器版 metadata + 去重闭环验证）
│       ├── integration-test.js# Node 端到端闭环（扫描→解密→播放URL→歌词→去重，含 Capacitor mock）
│       ├── web-smoke.js       # Node 网页端闭环（复用同一批核心 + MockAudio，验证网页形态可闭环）
│       ├── mock-loader.mjs    # ESM loader：把 @capacitor/filesystem 重定向到内存 mock
│       └── mock-capacitor-filesystem.mjs # 内存版 Capacitor Filesystem 替身
├── public/
│   ├── manifest.webmanifest   # PWA 清单
│   ├── sw.js                  # 网页版 Service Worker（缓存 App 壳，可「添加到主屏幕」）
│   └── icons/                 # PWA 图标（由 scripts/gen-icons.mjs 生成）
├── scripts/
│   ├── gen-icons.mjs          # 生成 PWA 图标（零依赖）
│   ├── build-apk.sh / .bat    # 本地一键构建 Android APK
├── .github/workflows/build-android.yml  # CI 自动出包（APK artifact）
└── (android/ ios/ 由 `npx cap add` 生成，不手写)
```

## 已验证（本机可闭环）

三件套自检全部通过（共 **58 项**）：

- `node src/tools/selfcheck.js` —— **25 项全绿**（解密 ncm/qq、歌词引擎、浏览器版 metadata、语义去重闭环），证明手机端复用的核心正确。
- `node --experimental-loader ./mock-loader.mjs integration-test.js` —— **19 项全绿**，用内存版 Capacitor Filesystem + MockAudio 在 Node 真实跑通**端到端**链路：扫描过滤 `.lrc` → 读字节 → 解密 → 播放器生成可播放 URL → 歌词引擎（同名 `.lrc` 优先级高于内嵌、flac 标签歌词按时间轴取行、mp3 USLT 命中）→ 语义去重识别重复组并保留音质最高版本。无需真机即可验证「能不能闭环」。
- `node src/tools/web-smoke.js` —— **14 项全绿**，复用**与网页版 `src/web/main.js` 完全相同**的核心模块（decrypt-bridge/player/lyric-bridge/identity-bridge），用 MockAudio + URL 替身证明**网页形态**下「解密→播放 URL→歌词→去重」同样能闭环（即网页版 App 的核心逻辑正确，上手机浏览器即可用）。

静态自检覆盖细项：

- API 暴露齐全（无未实现/未注册）
- **QQ 解密**：静态密钥对称对拍（构造加密样本→`decryptBuffer` 还原，含 `sniff` 格式识别）
- **NCM 解密**：双路径闭环（Node `crypto` 路径 + 浏览器纯 JS `AES128` 路径，构造合法 `.ncm`→解密还原音频+解析元数据）
- **decrypt-bridge** 路由：同一份 ncm 样本经 Web 端统一入口正确路由到 NCM 解码，并透传 `meta.lyric`
- **歌词引擎**：`lyrics.parse` 解析 + `at()` 取当前行；ncm 内嵌歌词经解密→登记→命中 `embedded`；同名 `.lrc` 优先级高于内嵌（`sidecar` rank 2 < `embedded` rank 3）
- **浏览器版 metadata**：FLAC Vorbis 标签（歌名/歌手/专辑/歌词）+ 普通 MP3 ID3v2 标签与 USLT 歌词，经 decrypt-bridge 透传到手机端 UI 与歌词引擎
- **语义去重**：`identity-bridge` 按「标题|歌手|专辑」三键归一识别精确重复组，每组按「音质>评分>播放次数>修改时间」挑保留版本，标注 `_dup`/`_dupKeep` 经 app 列表正确渲染

## ⚠️ 诚实边界（本环境限制）

本机是受限的 Windows 沙箱（无 Mac、无真机、模拟器起不来；**且 `npm install` 在此沙箱被环境拦截**——只放行网络只读与少量文件写入，任何落地装包/解包都会被掐断），**以下无法在此环境完成，需在具备条件的环境执行**：

1. `npm install`（本沙箱拦截写入 `node_modules`，即使纯 JS 小包也 exit 1；需在普通机器/CI 执行）
2. `npm run build`（Vite 打包，依赖上面的 install；CI 云端已具备）
3. `npx cap add android/ios` 生成原生壳
4. 真机/模拟器 build 出 APK/IPA
5. 真机点击、真机解密验证（同桌面端 GUI 同源限制）

> 已在本沙箱**实测确认**：核心逻辑（解密/歌词/去重）全部通过 58 项 Node 自检；但 `dist/` 二进制产物与 APK 无法在此产出。网页版与原生端**源码均完整**，且网页端核心管线已用 `web-smoke` 证明可闭环——你只需在能 `npm install` 的机器（或推送 GitHub 走 CI）即可一键出包。

因此本工程交付的是**完整、可审查、核心逻辑已通过 58 项 Node 自检验证（含原生端 + 网页端双形态闭环）**的代码 + **可安装的产物通道**（PWA + 一键构建脚本 + CI 出包）。原生二进制的真机表现需在真机/CI 实跑确认。

## 如何拿到手机端 App（三种方式）

详见 **[BUILD.md](./BUILD.md)**，要点：

- **方式 A · 网页版（最快、无需原生构建）**：`npm run build` 后部署 `dist/web.html`（或整个 `dist/`）。手机浏览器打开 → 「添加到主屏幕」即装即用。它用 `<input type=file webkitdirectory>` 选本地文件夹，复用与原生端完全相同的核心，支持 ncm/QQ 加密格式解密播放。逻辑已通过 `web-smoke` 闭环验证。
- **方式 B · 本地 APK**：`bash scripts/build-apk.sh`（或 `scripts\build-apk.bat`）一键产出 `app-debug.apk`，`adb install` 或侧载。前提是本机有 Node 17+ 与 Android SDK（platform-34 + build-tools）。
- **方式 C · CI 出包（强烈推荐，零本地环境）**：本目录已 `git init` 并完成首次提交。只需：
  ```
  git remote add origin <你的GitHub仓库URL>
  git push -u origin main
  ```
  然后在仓库 **Actions** 里手动触发 **Build Android APK** → 等 3~5 分钟 → 下载 Artifact `yeshi-music-android`（即 APK）→ 手机侧载安装。
- **iOS**：仅 macOS + Xcode 可 `cap add ios && cap sync ios && cap open ios`。

Android 10+ 受 **Scoped Storage** 限制，用户音乐通常在 `Music/`、`Download/` 或各 App 私有目录；若扫描为空，需在系统设置给「所有文件访问」权限，或在 `src/core/scan.js` 的 `DEFAULT_DIRS` 增补路径。

## 已知限制 / 后续

- **已接歌词来源**：① ncm 内嵌歌词（解密时从 `meta.lyric` 直接取，零重复解码）；② 同目录同名 `.lrc`（真机走 Capacitor Filesystem）；③ **普通/QQ 文件的标签内嵌歌词**（ID3 USLT / Vorbis LYRICS），由新增的 `core/metadata_browser.js` 解析、经 decrypt-bridge 透传。
- **元数据展示**：普通/QQ 文件现已显示歌名/歌手/专辑（取自标签），并附音质（无损/CD/码率）。
- 歌词缓存目前仅会话内内存级（`dir:''`）；如需跨会话落盘，给 `createMobileLyricEngine` 注入基于 Capacitor Filesystem 的 `fsx` 即可（已留好接口）。
- 本次顺手修了一个**桌面端共用的真实 bug**：`core/metadata.js` 与浏览器版 `decodeID3Frame` 的文本帧正则写的是 `/^T[A-Z]{2}$/`，只能匹配 3 字符 ID，而 ID3v2.3/2.4 的文本帧是 4 字符（`TIT2`/`TPE1`/`TALB`），导致这些帧没进「正确跳过编码字节」的分支，中文等 UTF-8 标签前缀出现乱码（`\u0003...`）。已放宽为 `/^T[A-Z0-9]{2,3}$/`，桌面端两版均修复且 parity 仍一致。
- 大文件全量解密进内存（Blob）适合本地曲库；超长文件可考虑流式解密。
- **曲库语义去重已接入**：扫描后在内存轻量解析每首元数据（标题/歌手/专辑/格式），调用 `annotateDuplicates` 标注重复组；列表对重复项显示「重复」徽章、对推荐保留版本显示「保留」徽章（按音质优先）。解析失败（损坏/无权限）自动回退到文件名身份，不影响整体。首次扫描需逐文件解密解析元数据，曲库很大时耗时与 I/O 较明显（属一次性成本；后续可加持久化元数据缓存）。
- 身份匹配引擎（把云盘歌匹配到本机曲库）按需后续接入；本次先搬了其中的**去重子集**（手机端本地曲库重复识别最常用）。

> 本次修了一个**手机端真机必现的真实 bug**：`lyric-bridge.findSidecar` 调异步 `readSidecar` 时漏写 `await`，导致 Promise 被当成歌词文本（同名 `.lrc` 永不在真机加载）。根因是 `core/lyricengine.js` 取词链路原本全同步、不支持异步读文件。已把 `LyricEngine.get`/`_fromSource` 升级为 `async`、移动端 `getLyric` 同步升级为异步，并让所有调用方 `await`，桌面端同步 API 一并兼容。另修 `app.js` 播放时引用未定义变量 `meta`（应为 `m`）的真机崩溃。两处均经 Type/集成测试覆盖。

> 本次顺手修了一个桌面端共用的真实 bug：`core/lyrics.js` 解析 `[ti:xxx]` 等元信息行时正则贪婪匹配，把结尾的 `]` 也吞进了 `title`（如 `"测试]"`）。已改为非贪婪 `(.*?)\]\s*$` 锚定收尾括号，桌面端与手机端歌词标题同时受益。
