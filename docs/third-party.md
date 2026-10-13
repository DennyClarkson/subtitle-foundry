# 第三方组件与便携分发

应用代码独立编写，以根目录 MIT LICENSE 发布。公开源码仓库不包含运行库、模型、FFmpeg、测试视频或用户工作目录。各依赖保留各自许可证；根目录 ELECTRON-LICENSE.txt 是 Electron 的独立声明。组装便携程序时保留组件附带的声明，并遵守相应源码提供/再分发义务。

| 组件 | 本次使用 | 来源与许可 |
|---|---|---|
| Electron | 44.7.0 | https://github.com/electron/electron · MIT，Chromium 等 notices 随 dist 保留 |
| React / React DOM | 19.3.0 | https://github.com/facebook/react · MIT |
| Vite | 8.3.4 | https://github.com/vitejs/vite · MIT |
| Node | 24.21.0 portable zip | https://nodejs.org/dist/v24.21.0/ · LICENSE 随 zip 保留，下载时核对官方 SHA256 |
| Whisper.cpp | b5454 Windows CPU | https://github.com/ggml-org/whisper.cpp/releases/tag/b5454 · MIT，ZIP SHA256 核对 |
| Whisper models | base / large-v3-turbo-q5_0 | https://huggingface.co/ggerganov/whisper.cpp · 模型来源 OpenAI Whisper，模型 SHA256 核对 |
| FFmpeg / ffprobe | Gyan 9.0 full build | https://www.gyan.dev/ffmpeg/builds/ · 此构建启用 GPLv3，LICENSE 随附 tools/ffmpeg |
| Microsoft VC runtime | app-local x64 DLL | 从此电脑现有的 System32 只读复制 MSVCP140、VCRUNTIME140、VCRUNTIME140_1 到 Whisper 目录，没有运行安装程序；受 Microsoft 运行库再分发条款约束 |
| Lucide | 1.55.0 | https://github.com/lucide-icons/lucide · ISC |
| Tailwind CSS | 4.3.3 | https://github.com/tailwindlabs/tailwindcss · MIT |
| yt-dlp | 2026.08.19 standalone | https://github.com/yt-dlp/yt-dlp · 用于测试素材下载，未集成到产品界面，分发许可证见其仓库 |

系统中文字体由 Windows 字体服务只读使用，没有安装字体。API Key 仅来自进程环境，不包含在便携目录。示例视频及下载片段不属于此应用代码的许可证范围。

GitHub 参考项目及实现取舍记录在 research-asr.md 和 research-api.md。本项目没有导入参考应用的源码或其 Python 依赖环境。
