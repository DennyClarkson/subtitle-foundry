# 字幕工坊 · Subtitle Foundry

Windows x64 便携字幕工作台，Electron + React：本地 Whisper 转写 → DeepSeek 校对/翻译 → 单语或双语 SRT / ASS → FFmpeg 烧录。支持任意工作目录、完整工作流预设与批量处理。

组装完成后双击根目录的 **字幕工坊.exe** 启动。它是完整的 Electron Windows 程序入口，不依赖 VBS、批处理启动器或安装程序。应用依赖留在应用文件夹，视频、预设及结果放在用户选择的工作目录。**GitHub 仓库提供源码；运行库、模型、视频和用户数据不随源码上传。** 从源码准备便携程序的方法见下文。

## 使用

批量处理：打开「批量工作流」→「选择工作目录」，可选任意可读写的文件夹。程序会读取其中 `presets/*.json`，并在第一次使用时加入「字幕组 · 英译中蓝边双语」预设。

将视频放进该目录的 `inputs`，点击「刷新」，选择预设，再点击「运行全部视频」。默认只处理 inputs 顶层；另存预设时可开启子文件夹扫描。每次运行使用预设的固定副本，按视频顺序依次转写、翻译、导出字幕和烧录；不会覆盖之前的结果。单个视频失败时默认继续其余视频，失败原因显示在列表中，也记录在结果目录。

默认预设：英语 → 简体中文，中文在上（微软雅黑 48、白字、蓝色 `#2864B4` 描边），英文在下（Arial 36、白字、深色描边），字号以 1920×1080 为基准自动缩放。去除中英文单个行末句号，保留小数、省略号、问号和感叹号。输出两份独立 SRT、双语 ASS、H.264 / AAC MP4。可载入预设到单视频页面调整全部参数，再到批量页面另存为统一预设。

时间控制位于「样式」：内置字幕组预设启用语音末尾收紧，最后一个可靠词时间之后保留 **80 ms**；相邻字幕间隔 **≤200 ms** 时延长前一句至后一句开始，减少闪烁。长停顿和最后一句不延长。可以手动设置提前结束量及单条最长时长（0 表示关闭）。手动提前结束默认 0，最长时长默认关闭，避免截断长句。缺少可靠词时间的旧项目/导入 SRT 保留原结束时间，可用手动控制修正。SRT、ASS、编辑预览和烧录共享相同时间处理，反复导出不会累计修改原始时间。

每个视频的结果结构：

```text
所选工作目录/
  inputs/                              待处理视频
  subtitles/                           字幕素材和单独导出的字幕
  presets/                             可编辑、可复制的工作流 JSON
  outputs/视频名-时间-唯一编号/
    subtitled.mp4                      已烧录视频（容器随预设变化）
    source.srt                         原文（双语预设）
    translation.srt                    译文（双语预设）
    subtitles.ass                      字幕样式
    project.json                       可继续编辑的项目
    workflow.json                      本次预设和处理结果
    transcript.txt                     ASR 逐字稿
  projects/                            保存的项目
  .subtitle-foundry/                   此工作目录的设置、记录和翻译缓存
```

工作目录可独立于应用目录移动。重新选择它即可重新读取预设；预设文件有格式问题时会显示原因，不会静默套用另一份配置。已有内置预设只补齐缺少的时间控制字段，保留用户设置过的样式和数值；自定义预设不被覆盖。上次目录暂时不可用时，程序会提示并打开应用内默认的 `workspace`，仍可选择其他目录。

单视频编辑仍可独立使用：

1. 导入视频，或点“载入样本”读取目录中的 final_video.mp4。
2. 选择语言、音轨和 ASR 模型，开始本地转写。Large v3 Turbo Q5 适合正式处理中英视频；Base 用于快速验证。CPU 模式无需显卡依赖。
3. 检查逐字稿，修正文本与时间。选择 DeepSeek 目标语言、原文校正 / 单语译文 / 双语，按需填写术语表，开始处理。
4. 选择 SRT 输出模式：原文一份、译文一份，或原文和译文两份。ASS 可以独立选择原文、译文或双语。
5. 选择字幕样式、字体、颜色、描边、位置、字号、编码及视频参数，导出字幕，或先渲染真实预览再烧录完整视频。
6. 保存项目，稍后恢复。已有 SRT 可直接导入；第二份 SRT 可作为译文轨导入。单独导出的字幕在所选工作目录的 subtitles，视频在 outputs，项目在 projects，不覆盖原素材。

DeepSeek 从当前进程环境变量 **Deepseek** 读取 Key；不会写入配置、项目文件或网页。修改环境变量后需重启应用。转写在本机完成；按“DeepSeek”处理时，字幕文本和术语表会发往 DeepSeek，视频/音频不会上传。单语导出和烧录已有字幕无需 API。

## 功能范围

- 带时间戳逐字稿、原始 Whisper JSON、文本稿，可编辑 SRT；时间戳来自 ASR，DeepSeek 不能修改时间轴。
- DeepSeek 按上下文分块校对/翻译，严格检查字幕 ID、数量、返回结构；遇到临时网络/限流错误重试，可以取消。
- SRT UTF-8 / UTF-8 BOM / UTF-16LE；读取时支持 GB18030。ASS 始终保存 UTF-8 BOM 以便 libass 一致渲染。
- 单语/双语 ASS、两种字号与颜色、字体、字距、对齐、边距、描边、阴影、背景框、时间偏移与换行。
- FFmpeg H.264/H.265/AV1/VP9/ProRes，软件及 NVENC/QSV/AMF 编码选项；容器、质量/码率、预设、像素格式、分辨率、帧率、音轨、音频编码/码率/采样率/声道等。
- 内置工作流/编码/字幕样式预设、任务进度、取消、错误提示、项目和设置保存。

FFmpeg 编译包含的编码器不代表本机一定有对应硬件；不支持的硬件编码会明确报错，可改用 libx264。HDR 色调映射是显式选项，普通素材默认保留色彩设置。实时视频上的字幕叠层仅用于编辑定位，**渲染预览**使用真正的 FFmpeg/libass，最终视觉效果以它为准。语音识别和翻译可能出错，正式使用前应校对。

## 便携目录

| 目录 | 用途 |
|---|---|
| runtime | 便携 Node（仅维护/构建用） |
| 字幕工坊.exe / resources / locales / 根目录 DLL | Electron 应用主程序和运行库 |
| node_modules/electron/dist | 开发与重建使用的 Electron 源运行时 |
| tools/ffmpeg | FFmpeg + ffprobe |
| tools/whisper | Whisper CLI、模型运行 DLL、应用本地 VC 运行库 |
| tools/models | Base 和 Large v3 Turbo Q5 模型 |
| data | Electron 配置、依赖缓存、临时文件、所选工作目录的路径 |
| workspace | 默认工作目录，可在界面改为其他磁盘或文件夹 |
| outputs | 兼容旧版已有结果 |
| src / electron / shared | 完整源代码 |

移动应用时复制**整个文件夹**，不要单独复制 exe。运行时、依赖和 Electron 缓存留在应用目录，媒体、预设、项目及结果写入用户选择的工作目录；不在其他位置安装软件。应用不修改系统环境变量，不注册服务，不创建安装项。已有系统字体只读使用；可换成系统中已有的中文字体。

任务历史最多 50 条，只保留结果摘要。预览缓存最多 3 个目录 / 256 MiB / 7 天；翻译缓存最多 100 项 / 64 MiB / 30 天；批量记录最多 50 项 / 16 MiB / 30 天。任一上限超出就回收最旧缓存，正在使用的预览暂时保留。提取的 WAV、未完成的编码和批量 `.work` 在结束/失败/取消后清理；异常退出遗留的已标记临时文件会在后续维护时恢复清理。用户输入、项目、逐字稿、字幕和正式输出由用户管理，不自动删除。

## 从源码准备便携程序

1. 克隆仓库到可写目录。Windows x64 为当前支持平台。
2. 从 [FFmpeg 官方 Windows 下载入口](https://ffmpeg.org/download.html#build-windows) 获取含 libass 的便携构建，将 `ffmpeg.exe`、`ffprobe.exe` 及许可证放入 `tools/ffmpeg`。为使用全部软件编码选项，建议使用 full build。
3. 在仓库根目录运行 `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`。脚本下载校验过的 Node、Whisper、模型，在本目录安装锁定的 npm 依赖并组装 Electron exe。可用 `-SkipModels` 跳过模型，之后从应用下载。
4. 设置当前进程可见的环境变量 `Deepseek`，重新启动 `字幕工坊.exe`。已有字幕的转换/烧录无需 API Key。不要把密钥写进预设或源码。

Whisper 需要应用本地的 x64 VC 运行库；脚本会从本机已有 System32 只读复制三个 DLL。如果电脑没有对应运行库，脚本会明确提示缺少文件，需将合法取得的 app-local 运行库放到 `tools/whisper/Release` 后重跑；它不会安装系统组件。模型下载体积较大，需要网络和足够磁盘空间。

## 开发和验证

所有命令在项目根目录运行：

```powershell
.\scripts\check.cmd
.\runtime\node-v24.21.0-win-x64\node.exe scripts\e2e.cjs
```

当前版本通过 TypeScript 检查、生产构建和自动测试，并在真实根目录 exe 中验证工作目录、预设和批量界面。两个英语片段在应用目录之外的工作目录中完成真实 Whisper → DeepSeek → 字幕 → FFmpeg 流程。详细记录见 [docs/validation.md](docs/validation.md)。本次与历史测试媒体均在验收后清理。

当前真实批量检查可用便携 Node 执行 `scripts/validate-workspace.cjs`；会调用 DeepSeek、从 final_video.mp4 截取两个 7 秒片段，临时外部工作目录自动清理。可选 `--keep-review` 才会将画面验收图和 JSON 报告保留在 data/temp。界面测试 scripts/e2e.cjs 自动清理自己的工作目录，其中 ASR/翻译使用桩以避免重复 API 费用，FFmpeg 预览和批量编码使用真实程序。应用内翻译使用文本与设置的哈希缓存，失败/取消后按相同设置重试可跳过已校验的批次。

依赖锁定在 package-lock.json。需要修复或重建时重新运行 setup.ps1；所有下载和 npm 缓存仍在此目录。

原生 exe 分发文件由 `scripts/package-portable.cjs` 从当前目录已验证的 Electron 运行时组装，入口是 resources/app/main.cjs。当前 exe 直接读取本目录的 electron 与 dist，更新源码并构建后重启即可；重建完整分发时再运行组装脚本。

MiniMax 中文合成测试脚本为 scripts/generate-chinese.cjs，读取 MINIMAX；它是可选的测试辅助工具，应用正常运行不依赖 MiniMax。测试来源和结果见验证记录。

## GitHub 参考与第三方组件

实现前参考：[VideoLingo](https://github.com/Huanshere/VideoLingo) 的上下文翻译与校验思路、[Leg2Sub](https://github.com/Paulogb98/Leg2Sub) 的 Electron/React 桌面流程、[whisper-desktop](https://github.com/AtomicError/whisper-desktop) 的本地 ASR 与烧录工作台、[Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) 的字幕选项。应用代码独立编写，未复制这些项目源码。

本次双语布局参考 [video-subtitle](https://github.com/limin112/video-subtitle) 的上中文、下方较小外文排版；字体描边、颜色与缩放按照 [Aegisub ASS 样式说明](https://aegisub.org/docs/latest/styles/) 实现。蓝色及具体字号是本应用的可编辑预设，不代表唯一的字幕组标准。

应用源码以 [MIT](LICENSE) 发布。转写引擎：[whisper.cpp](https://github.com/ggml-org/whisper.cpp)（MIT），模型：[OpenAI Whisper GGML](https://huggingface.co/ggerganov/whisper.cpp)；媒体处理：[FFmpeg](https://ffmpeg.org/) / [Gyan Windows builds](https://www.gyan.dev/ffmpeg/builds/)（本地 full build 含 GPL 组件）。Electron/React/Lucide/Node 等许可证保留在各自分发目录。详细来源、版本和限制见 docs/research-asr.md、docs/research-api.md、docs/third-party.md。
