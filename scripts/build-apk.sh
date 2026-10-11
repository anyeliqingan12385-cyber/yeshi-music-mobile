#!/usr/bin/env bash
# 本地一键构建 Android APK（需已装：Node>=18、JDK17、Android SDK+platform-34+build-tools）。
# 默认产出 debug APK（可直接 adb install / 侧载安装，无需签名）。
set -e
cd "$(dirname "$0")/.."

echo "[1/4] 安装依赖并构建网页产物"
npm install
npm run build

echo "[2/4] 生成原生壳（若 android/ 不存在）"
if [ ! -d "android" ]; then
  npx cap add android
fi

echo "[3/4] 同步 Web 产物到原生壳"
npx cap sync android

echo "[4/4] 构建 APK"
cd android
if [ "${RELEASE:-0}" = "1" ]; then
  ./gradlew assembleRelease
  echo "Release APK: android/app/build/outputs/apk/release/app-release.apk (需先配置签名)"
else
  ./gradlew assembleDebug
  echo "Debug APK: android/app/build/outputs/apk/debug/app-debug.apk"
fi
