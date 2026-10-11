@echo off
REM Local one-click Android APK build. Requires Node>=18, JDK17, Android SDK (platform-34 + build-tools).
REM Default: debug APK (adb install / sideload, no signing needed). Set RELEASE=1 for signed release.
cd /d "%~dp0.."

echo [1/4] install deps and build web
call npm install
call npm run build

echo [2/4] add native shell if missing
if not exist "android" (
  call npx cap add android
)

echo [3/4] sync web assets
call npx cap sync android

echo [4/4] build APK
cd android
if "%RELEASE%"=="1" (
  call gradlew.bat assembleRelease
  echo Release APK: android\app\build\outputs\apk\release\app-release.apk (configure signing first)
) else (
  call gradlew.bat assembleDebug
  echo Debug APK: android\app\build\outputs\apk\debug\app-debug.apk
)
