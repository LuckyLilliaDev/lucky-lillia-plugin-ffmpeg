# FFmpeg 源码来源

插件仓库的 `engine/ffmpeg/` submodule 固定 FFmpeg 上游提交
[`9bfa1635aef08e777deaeeae15ff9a5ade412188`](https://github.com/FFmpeg/FFmpeg/commit/9bfa1635aef08e777deaeeae15ff9a5ade412188)。
提交时间为 `2026-02-09T04:25:04Z`，标题为
`avformat/iff: Error out with 0 channel loudspeaker configuration`，
Git tree 为 `3ce4e0fca93864e7bd517b95f91c1e9b5513328e`。

迁移时对原 Bot `script/ffmpeg` 目录逐文件核验：上游提交中的 **10,080 个文件**
均存在于原目录，文件内容的 Git blob SHA-1 全部与该提交一致。没有需要保留为补丁的
FFmpeg 源码修改，因此 `ffmpeg-source.json` 的 `patches` 为空。定制的精简构建由
`components.txt` 和构建脚本控制；源码版本号 `8.0.git` 仅作为版本信息，不作为等价证据。
原来的精简构建脚本保留为 `legacy/build-ffmpeg.sh`。
本文未加 `engine/` 前缀的文件路径均相对原生引擎目录；来源记录与构建脚本随插件仓库
一同维护，两个上游 submodule 的注册信息在仓库根目录 `.gitmodules`。

完整源码的 SHA-256 文件树校验值为：

```text
6235b79db0cfea8b4e91a415e2a9127faef8c11b5ca26129067121b52d41b0d5
```

校验算法是按相对路径排序，为每个文件生成
`{"path":相对路径,"sha256":文件原始字节的SHA256,"size":字节数}`，
然后对整个数组的紧凑 `JSON.stringify()` UTF-8 编码计算 SHA-256。字段顺序如上，
路径使用 `/`，不归一化文件内容或换行。生成的 `VERSION` 和 `.source-ready` 不属于
上游源码，校验时单独处理。

迁移前的临时快照使用 FFmpeg 的 `.gitignore` 过滤未跟踪文件，其中 `*_g` 规则意外
遗漏了上游实际跟踪的两个 FATE 测试参考文件。它们并未被用户删除，也不是源码补丁：

| 文件（相对 `tests/ref/fate/`） | 字节数 | SHA-256 |
|---|---:|---|
| `h264-conformance-canl1_toshiba_g` | 17490 | `34c129bb044896793b2521f636b9f402a91d73ac0b3b7ff5dbb860f883e430f1` |
| `h264-conformance-cvmaqp2_sony_g` | 1076 | `89ea638e6c4387f20e6c3836546c4c1945af84ed8c0b23af477ea3c97b5def43` |

新构建保留这两个文件，并用 `fullSourceTreeSha256` 校验全部 10,080 个文件。
为准确对应已经编译的二进制，`sourceTreeSha256` 保留旧快照的 10,078 文件视图，
`sourceHashExclusions` 明确列出上述两个仅在兼容校验时排除的路径，值为：

```text
679758ea78c023abb8a9e24045b3b2c6fef1a699545aa79bdcbcc5dc57c2b318
```

历史快照压缩包的 SHA-256 是
`ef348c4516d89d29f24f23d9210e75bef3ab85c1a6bd69d7415a500122f6f926`。
这个值只记录历史产物的来源；当前源码从真实 Git submodule 导出，不依赖该压缩包。
后续源码准备同时检查完整和兼容文件树，不能只检查版本号或忽略有差异的文件。
