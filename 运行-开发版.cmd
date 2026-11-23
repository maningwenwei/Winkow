@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Winkow 开发版启动器（源码运行，含未打包的新改动）
rem
rem  为什么不直接双击 electron.exe：它必须带一个「应用目录」参数才能
rem  知道要加载哪个项目。只双击 exe 会打开 Electron 的默认欢迎页。
rem
rem  为什么清掉 ELECTRON_RUN_AS_NODE：这个变量会让 electron.exe 退化成一个
rem  普通 node 解释器，于是 require('electron') 拿到的是路径字符串而不是模块，
rem  表现就是启动即报 "Cannot read properties of undefined".
rem ============================================================

set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 找不到 node_modules\electron\dist\electron.exe
  echo        先在当前目录执行： npm install
  echo.
  pause
  exit /b 1
)

echo 正在启动 Winkow（源码版）...
echo   项目目录： %CD%
echo   画面通道： 引擎 -vnet 直出 H264 -^> 浮窗 WebCodecs 解码
echo.

"node_modules\electron\dist\electron.exe" .

if errorlevel 1 (
  echo.
  echo [退出码 %errorlevel%] 启动失败，把上面的报错发我。
  pause
)
