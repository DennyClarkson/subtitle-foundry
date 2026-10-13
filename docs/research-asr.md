# Portable Windows ASR research

Verified 2026-10-13. Research only: no installation, PATH change, or system modification performed.

## Recommended engine and assets

Use **whisper.cpp CLI**, invoked as a child process with absolute paths and `shell: false`. Keep a CPU backend available even when CUDA is selected. Keep transcript extraction independent of LLM translation; preserve source timing and use stable cue IDs throughout translation.

The GitHub API reports latest semantic release `v1.9.5` with **zero binary assets**. The newest binary release is prerelease **b5454**, commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`, published 2026-10-06. Pin the release instead of constructing binary URLs from `/releases/latest`.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| [CPU x64](https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip) | 8,928,640 | `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb` |
| [CUDA 12.4 x64](https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip) | 684,913,404 | `afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a` |
| [CUDA 11.8 x64](https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-11.8.0-x64.zip) | 284,761,231 | `e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027` |

CPU archive was downloaded **in memory**, independently hashed, and its directory inspected. It contains `Release/whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, and numerous `ggml-cpu-*.dll` backends. Preserve the backend DLLs. Other executable examples can be omitted from a deliberate redistribution.

**Critical dependency:** CPU CLI binary imports `MSVCP140.dll`, `VCRUNTIME140.dll`, and `VCRUNTIME140_1.dll`; the CPU archive does not include these. Bundle the permitted app-local MSVC redistributable DLLs alongside the executable, with appropriate notices. Test all DLL dependencies, not only the executable. Windows UCRT/API-set DLLs are OS dependencies; do not copy arbitrary Windows system DLLs. [Microsoft app-local deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/determining-which-dlls-to-redistribute?view=msvc-170).

Sources: [release API](https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5454), [release workflow](https://github.com/ggml-org/whisper.cpp/blob/b5454/.github/workflows/release.yml).

## Models

Use multilingual model names for Chinese/mixed-language audio; `.en` models are English-only. Start with `base` for a small initial download and CPU smoke tests; offer `large-v3-turbo-q5_0` for better transcription quality. Quantization trades some precision for lower storage and memory requirements.

Pin Hugging Face revision `5359861c739e955e79d9a303bcbc70fb988958b1`:

`https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/<filename>`

| Filename | Bytes | SHA-256 (LFS object ID) |
| --- | ---: | --- |
| `ggml-tiny.bin` | 77,691,713 | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| `ggml-base.bin` | 147,951,465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| `ggml-small.bin` | 487,601,967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| `ggml-large-v3-turbo-q5_0.bin` | 574,041,195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| `ggml-large-v3-turbo.bin` | 1,624,555,275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |

Hashes are provider metadata, not locally verified model downloads. Download to `.part`, verify length and SHA-256, then atomically rename. Do not accept an HTML error page or Git LFS pointer as a model. [Model metadata API](https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1?recursive=false&expand=false), [official model instructions](https://github.com/ggml-org/whisper.cpp/blob/b5454/models/README.md).

## CLI and JSON contract

Use an isolated ASCII-named job working directory if dealing with unfamiliar Windows command-line encoding; keep original display names in metadata. Suggested layout:

```text
app-root/
  runtime/ffmpeg/{ffmpeg.exe,ffprobe.exe}
  runtime/whisper/cpu/{whisper-cli.exe,...DLLs}
  runtime/whisper/cuda/{whisper-cli.exe,...DLLs}
  models/ggml-base.bin
  data/{config,cache,temp,jobs}/
```

PowerShell examples below express the process contract; application implementation should supply argument arrays, not interpolate shell strings.

```powershell
& $ffmpegExe -nostdin -hide_banner -y -i $inputVideo -map 0:a:0 -vn -ar 16000 -ac 1 -c:a pcm_s16le $jobWav
& $whisperExe -m $modelFile -f $jobWav -l auto -ojf -osrt -otxt -of $outputStem -pp -t 8 -ng
```

Drop `-ng` to enable GPU use. `-of` is a path **without extension**. Read the completed `.json` file; treat stderr as diagnostics/progress. Wait for exit status 0 and validate output before advancing the pipeline.

The JSON root contains `result.language` and `transcription[]`. Each segment has `text`, `timestamps`, numeric `offsets.from/to` in **milliseconds**, and, under `-ojf`, `tokens[]`. Token records include `text`, `id`, `p`, and `t_dtw`; `offsets` may be absent. `-ojf` enables token timestamps itself. Do not multiply JSON offsets by 10; that conversion has already happened in the CLI.

Illustrative shape, not a captured transcription:

```json
{
  "result": { "language": "en" },
  "transcription": [{
    "timestamps": { "from": "00:00:00,000", "to": "00:00:02,000" },
    "offsets": { "from": 0, "to": 2000 },
    "text": " Hello world.",
    "tokens": [{ "text": " Hello", "offsets": { "from": 0, "to": 800 }, "id": 2425, "p": 0.9, "t_dtw": -1 }]
  }]
}
```

These are model tokens, **not guaranteed words or forced alignment**. Filter special tokens, merge text fragments as needed, and retain segment timing when token timing is absent, invalid, or zero-length. `-sow` controls splitting on word boundaries; it does not change tokens into word objects. `-ml` constrains segment character length and can alter segmentation. `-dtw` is a distinct, model-specific alignment option; avoid enabling it blindly for arbitrary models.

Evidence: [pinned CLI implementation](https://github.com/ggml-org/whisper.cpp/blob/b5454/examples/cli/cli.cpp), [timestamp and model API](https://github.com/ggml-org/whisper.cpp/blob/b5454/include/whisper.h).

## Machine findings and GPU strategy

Read-only inspection found NVIDIA GeForce RTX 5070 Ti Laptop GPU, driver **610.88**, **12,227 MiB** reported VRAM, plus Intel graphics. CUDA 12.4 release builds include their CUDA DLLs and do not require a toolkit installer. The build disables native-only architecture selection and includes PTX. NVIDIA documents PTX forward compatibility for Blackwell. Therefore the official CUDA 12.4 archive is a reasonable candidate, but **real inference must pass on this GPU before marking the backend ready**. Compatibility is not proven by `--help`. Keep an explicit CPU fallback and retain failed GPU diagnostics. [CUDA CMake architecture selection](https://github.com/ggml-org/whisper.cpp/blob/b5454/ggml/src/ggml-cuda/CMakeLists.txt), [NVIDIA Blackwell compatibility](https://docs.nvidia.com/cuda/blackwell-compatibility-guide/).

Set `CUDA_CACHE_PATH` to `app-root/data/cache/cuda` in the child environment to contain JIT caching. Set child `TEMP`/`TMP` similarly, and keep Electron userData/session/cache under the portable root. Do not change global environment variables.

Existing FFmpeg is Gyan **9.0 full**, statically linked, with libass, libx264, libx265, and NVENC. Read-only location:

```text
%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-9.0-full_build\bin\ffmpeg.exe
```

Copy `ffmpeg.exe`, `ffprobe.exe`, and the package's `LICENSE`/relevant notices into the portable runtime when building the app. This build enables GPL/version3, so preserve its redistribution obligations. Avoid relying on its current PATH location at runtime. For ASS burn, use a fixed relative `subtitle.ass` in job `cwd` to avoid FFmpeg filter escaping problems with Windows drive letters and quotes. Use `-map 0:v:0 -map 0:a? -vf ass=subtitle.ass -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k -movflags +faststart` as a conservative MP4 profile.

## Reference project decisions

- [VideoLingo](https://github.com/Huanshere/VideoLingo) is Apache-2.0. Its current setup installs uv/Python/dependencies and uses Qwen3-ASR + ForcedAligner by default, with WhisperX a manual backend. Borrow the workflow ideas of semantic segmentation, translation, and subtitle length handling; do not embed its installer into a folder-contained Electron application.
- [Const-me/Whisper](https://github.com/Const-me/Whisper) is MPL-2.0 and its latest release is **1.12.0 (2023-07-22)**. [WhisperDesktop.zip](https://github.com/Const-me/Whisper/releases/download/1.12.0/WhisperDesktop.zip) is 476,830 bytes; [cli.zip](https://github.com/Const-me/Whisper/releases/download/1.12.0/cli.zip) is 377,919 bytes. Its Direct3D11 backend and static runtime are attractive, but older engine/model support and a different CLI contract make it unsuitable as the primary adapter for modern turbo models. Do not assume its models or JSON flags are interchangeable with modern whisper.cpp.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) is MIT. Preserve its license. Model availability through a host does not replace model license notices; retain the upstream Whisper/model card provenance too.

## Acceptance checks for the implementer

1. Verify archives/models by the pinned hashes above and app-local DLL presence.
2. Run real short speech through CPU and optional GPU; assert valid timed JSON and correct nonempty speech text.
3. Move/copy the entire app root and repeat without using system PATH dependencies.
4. Test Unicode/spaces in source paths, no-audio input, silence, cancellation, interrupted downloads, and invalid model data.
5. Burn an ASS fixture with CJK and bilingual text; inspect the actual rendered frames.

This research did not execute ASR inference or download large models/CUDA archives. Those are implementation verification steps, not established results.
