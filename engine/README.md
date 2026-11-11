# LuckyLillia.FFmpeg.node

此目录是 `lucky-lillia-plugin-ffmpeg` 仓库内的原生引擎，与插件入口在同一个 Git 仓库维护，
没有独立的 npm 包。Bot 不内置这些二进制。插件安装和打包说明见 [仓库首页](../README.md)。
除特别注明外，下文命令均在 `engine/` 目录执行。

通过 Node-API 8 直接调用 libavformat、libavcodec、libswresample、libswscale。
媒体任务在线程池中执行，运行时无需 FFmpeg、ffprobe 或命令行子进程。支持 Node 22 及以后版本。
SILK 通过独立 Skype SDK 静态链接到同一个模块，和 FFmpeg 之间只传递内存 PCM。
不修改 FFmpeg 源码、不注册第三方 FFmpeg codec，也不使用 WASM。

## 源码

`ffmpeg/` 是 FFmpeg 官方仓库的 Git submodule。`ffmpeg-source.json` 固定上游 commit、
补丁 SHA256 和源文件树 SHA256；`patches/` 保存原定制源码相对上游的修改。
版本来自原 Bot `script/ffmpeg` 的 **8.0.git** 源码。逐文件核对 Git blob 哈希后确认上游
commit 为 `9bfa1635aef08e777deaeeae15ff9a5ade412188`，没有源码修改；当前补丁列表为空。
定制内容在构建组件白名单中。原快照遗漏两个被 `*_g` 忽略规则匹配的 FATE 测试期望文件；
它们仍保存在完整 submodule 中，来源记录列出两个路径并校验完整文件树，不伪造删除补丁。

```bash
git submodule update --init --recursive
node prepare-source.mjs output/source-check
```

源码准备会从固定 commit 导出到独立目录，应用已校验的补丁，再核对全部源文件的内容、
路径和大小。先验证完整 10,080 文件树，再验证排除上述两个测试文件后的 10,078 文件哈希
与历史构建快照一致；不会删除这两个文件。随后才生成固定 `VERSION` 和缓存凭据，
避免外层仓库的 Git 版本影响 FFmpeg 版本。不会修改或清理 submodule。
修改 FFmpeg 时应更新补丁与来源记录并重建六个平台，不在 submodule 中保留未提交修改。

六个平台共用 `components.txt`：以保留在 `legacy/build-ffmpeg.sh` 的原 `--disable-everything`
白名单为基础，移除 CLI、网络、设备、pipe 协议和 avfilter，保留音视频解码、媒体信息和
PNG 缩略图。只为 Bot 已有输出增加 MP3、AMR、WMA、M4A、SPX、OGG、WAV、FLAC 编码器/
封装器。PNG/JPEG 的 pipe demuxer 是内容格式识别器，与被禁用的 pipe protocol 无关。
固定依赖版本、下载地址和 SHA256 在 `sources.tsv` 中。

`silk-sdk/` 是 [kn007/silk-v3-decoder](https://github.com/kn007/silk-v3-decoder) 的真实
submodule，固定 commit `507be6bca8ce1fb977a061481f1d79e8c610e309`。它包含 Skype SILK SDK
**1.0.9.6**；这里只编译 `silk/src/*.c` 库源码，不编译 `.S`、测试程序或 converter 脚本。
`silk-source.json` 固定 163 个库源码/头文件/构建说明/许可证文件的完整哈希。源码准备直接
从固定 Git tree 导出这些对象，不依赖下载或执行仓库中的 Windows 程序；支持 sparse checkout。
SDK 使用 C99、`-fPIC -fwrapv -fno-strict-aliasing`，未修改上游源码。

## 本机构建

需要 Git、Bash、GNU Make、C/C++17 工具链、pkg-config、curl、tar、Node；x64 另需 NASM。
Windows 使用 MSYS2 **UCRT64** GCC；macOS 使用 Clang；Linux 使用 GCC。所有外部 codec 库
默认从固定源码静态编译到私有目录，不移动系统库。

```bash
bash build.sh --target win-x64
bash build.sh --target macos-arm64
bash build.sh --target linux-glibc-x64
bash build.sh --target linux-glibc-arm64
bash build.sh --target linux-musl-x64
bash build.sh --target linux-musl-arm64
```

各命令在对应 OS、架构和 libc 的主机/容器执行；目标不匹配时脚本拒绝构建。
默认工作目录 `output/ffmpeg-native/<target>/`，用 `--work-dir` 更改；下载缓存默认
`output/ffmpeg-downloads/`，用 `FFMPEG_DOWNLOADS` 更改。路径不能包含空格。
输出 `artifacts/<target>/LuckyLillia.FFmpeg.node` 和 `build.json`，用 `--output` 更改。

支持 `CC`、`CXX`、`AR`、`RANLIB`、`STRIP`、`CFLAGS`、`CXXFLAGS`、`LDFLAGS`、`JOBS`、
`NODE`。`NODE_HEADERS` 指向已有 `include/node`，Windows `NODE_LIB` 指向已有 `node.lib`；
默认下载固定 Node 22.22.2 文件并校验。`--deps-prefix` 用于本地调试复用静态库，产物明确
标记 `local-override`；发布构建使用默认固定源码依赖。

完整构建生成 `libav-cache.json`，记录静态库、头文件、pkg-config 与 FFmpeg 构建配置的哈希。
只改 addon 或 SILK 时可用 `--reuse-build <上次工作目录>`，验证这些输入和目标/组件/源码
都一致后复用 libav，只重建 SILK 与 addon。元数据保留 libav 的原始来源，不能给旧二进制
更换标签。旧缓存仅在确认对应完整构建成功后，使用 `libav-cache.mjs capture` 建立凭据。

CI 由仓库根目录的 [`.github/workflows/build.yml`](../.github/workflows/build.yml) 手动触发：Windows UCRT64、macOS ARM64、Linux 原生
x64/ARM64。glibc 使用 Debian Bullseye（2.31），musl 使用 Alpine，macOS 最低版本 11.0。
每个任务在 `engine/` 完整构建并运行媒体 smoke，上传二进制、重新链接材料和对应源码。
汇总任务把六平台产物放入 `engine/artifacts/`，同步到插件 `native/` 后校验、运行加载器
测试并生成 `.tgz`；安装包、源码和六份 relink 包统一放在 `ffmpeg-plugin-distribution`
artifact 中。此流程不安装未发布的 SDK，插件服务测试使用本地 Bot 工作区。

## Linux 主机交叉构建

`cross-build.sh` 保存已实际使用的 Zig **0.14.1** 配方，可在 Linux x64（包括 WSL）构建
四个 Linux 目标和 macOS ARM64。需要 GNU Make、pkg-config、curl、tar、Python 3、Node、
Git、LLVM nm/objdump。

```bash
ZIG=/path/to/zig bash cross-build.sh linux-glibc-arm64
ZIG=/path/to/zig bash cross-build.sh macos-arm64
```

默认工作目录 `output/ffmpeg-cross-build/`，用 `FFMPEG_CROSS_WORK` 更改；`LLVM_NM`、
`LLVM_OBJDUMP` 指定工具，`JOBS` 控制并发。使用相同固定源码和组件白名单、portable C
路径并禁用汇编。glibc 基线 2.28，macOS 基线 11.0；Zig 使用内置 Darwin 头文件与
libSystem 链接描述。Linux 生成的 config.h 关闭已废弃 sysctl 探测，不更改 FFmpeg 源码。

源码、依赖或构建配方变化后使用新的工作目录，脚本会拒绝混用旧对象。编译前复制 addon
源码和组件配置，打包时核对哈希，防止二进制与元数据错配。交叉编译不等于运行验证；
Linux 可使用目标 Node/libc 和 QEMU 验证，macOS 必须在 Mac/CI ARM runner 上运行 smoke。
已有交叉构建 libav 缓存时，依次调用 `cross/build-silk.sh`、`cross/link-addon.sh`、
`cross/package-target.sh` 并传入相同目标，避免重编 FFmpeg。`silk-build.json` 绑定实际 SDK
静态库与编译配方；`build.json` 的 `silkSource` 记录对应 commit、源码哈希和 SDK 版本。

## 接口与验证

除 `version()` 和 `silkVersion()` 外，接口均返回 Promise：

- `probe(path)`：宽、高、时长、格式和文件大小。
- `decodeAudio(path, { sampleRate, channels })`：有符号 16 位小端 PCM Buffer。
- `encodeAudio(pcm, path, { sampleRate, channels, format })`：MP3、AMR、WMA、M4A、SPX、OGG、WAV、FLAC、SILK。
- `transcodeAudio(input, output, { format })`：按编码器约束保留采样率和声道。
- `thumbnail(path, { maxWidth, maxHeight, time })`：PNG Buffer，支持旋转/镜像元数据。
- `version()`：FFmpeg 版本。
- `silkVersion()`：独立 Skype SILK SDK 版本。SILK 支持内容识别、探测、解码、腾讯语音编码
  和音频转码；`format: 'silk'` 使用 24 kHz 单声道，通过 libswresample 适配输入 PCM。

```bash
node smoke.mjs artifacts/win-x64/LuckyLillia.FFmpeg.node
node sync-to-plugin.mjs
```

smoke 路径换成当前平台：检查九种编码/解码、无损 PCM、采样率/声道、视频/静态图探测、
缩略图的 90/180/270 度旋转与镜像、中文路径、并发、无效输入和超大图片拒绝。
SILK 还验证独立编码器产生的标准/腾讯头、多帧 packet 与精确 PCM 哈希，覆盖短输入尾帧和畸形数据。
`--limited` 仅用于早期 WAV 原型，不能作为发布验证。同步脚本校验六个平台的源码/配置/
二进制哈希，再复制到本仓库根目录的 `native/`。也可在仓库根目录运行 `npm run sync:native`。
普通插件安装/更新会一起带上 loader 和六个平台的原生模块，Bot 无需 `engine/` 源码。

## 许可证和重新链接

启用 opencore-amr 的 Apache-2.0 代码后，FFmpeg 使用 `--enable-version3`，组合按
LGPL-3.0-or-later 分发；未启用 GPL codec。LAME 为 LGPL，其他 codec 为 Apache/BSD/Zlib。
GCC 静态运行库附带 Runtime Library Exception；Zig 的 LLVM libc++/libc++abi/libunwind
附带 Apache-2.0 WITH LLVM-exception，compiler-rt 附带 MIT。`licenses/` 随模块分发。
SILK 库源码中的 Skype 声明为 BSD-3-Clause-Clear，原文随包附带；镜像仓库根目录的 MIT
是另一份声明，不能用它替代 SDK 自身的许可证。

每个平台生成 `output/ffmpeg-native/<target>/ffmpeg-relink-<target>.tar.gz`；交叉构建
位于 `output/ffmpeg-cross-build/`。包含 addon 对象、静态库、构建配置和链接信息，
用于替换 libav/codec 后重新链接。发布时应同时提供对应源码（本仓库、固定 FFmpeg
源码及补丁、固定依赖源码、SILK SDK 源码）和 relink 包。relink 同时包含 SILK 静态库
与精确源码。CI 会上传这些材料；源码 tar 保留点文件，
源码包保留整个插件仓库的目录布局；`engine/ffmpeg/` 是原始上游源码，补丁另附，
不包含 Git 数据库。正常开发使用带 submodule 的仓库 checkout；仅持有源码 tar 时，
从解压根目录进入 `engine/`，重建两个上游的 Git 索引：

```bash
cd engine
git -C ffmpeg init
git -C ffmpeg config core.autocrlf false
git -C ffmpeg remote add origin https://github.com/FFmpeg/FFmpeg.git
git -C ffmpeg fetch --depth 1 origin 9bfa1635aef08e777deaeeae15ff9a5ade412188
git -C ffmpeg reset --mixed FETCH_HEAD
git -C silk-sdk init
git -C silk-sdk config core.autocrlf false
git -C silk-sdk remote add origin https://github.com/kn007/silk-v3-decoder.git
git -C silk-sdk fetch --filter=blob:none --depth 1 origin 507be6bca8ce1fb977a061481f1d79e8c610e309
git -C silk-sdk reset --mixed FETCH_HEAD
git -C silk-sdk sparse-checkout set --no-cone /LICENSE /silk/Makefile /silk/interface/ /silk/src/
node prepare-source.mjs output/source-check
node prepare-silk.mjs output/silk-source-check
```

这些命令适用于刚解压的源码 tar；`reset --mixed` 建立对应索引而不覆盖源码文件。
之后运行上面的构建命令。未来源码版本请使用该版本 `ffmpeg-source.json` 的 commit。
修改二进制后重新生成 `build.json` 和 SHA256，再同步到插件。
