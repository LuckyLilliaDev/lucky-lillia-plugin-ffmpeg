import { Service } from '@luckylillia/plugin-sdk'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'ffmpeg'

/** @param {import('@luckylillia/plugin-sdk').Context} ctx */
export function apply(ctx) {
  const require = createRequire(import.meta.url)
  const nativeRoot = fileURLToPath(new URL('../native/', import.meta.url))
  const loaderPath = require.resolve('../native/loader.cjs')
  // A package update can replace this private JS loader as well as the binary.
  delete require.cache[loaderPath]
  // Fail initialization before publishing a service if the engine is unavailable.
  const addon = require(loaderPath).loadNative(nativeRoot)
  if (typeof addon.version !== 'function' || !addon.version()) {
    throw new Error('FFmpeg 原生模块缺少版本信息，请重新安装完整的 FFmpeg 媒体服务插件')
  }
  if (typeof addon.silkVersion !== 'function' || !addon.silkVersion()) {
    throw new Error('FFmpeg 原生模块缺少 SILK 支持，请重新安装完整的 FFmpeg 媒体服务插件')
  }

  // Native state belongs to this mounting's closure, independent of Cordis service shadows.
  class FFmpegService extends Service {
    constructor(context) { super(context, 'ffmpeg') }
    probe(inputPath) { return addon.probe(inputPath) }
    decodeAudio(inputPath, options) { return addon.decodeAudio(inputPath, options) }
    encodeAudio(pcm, outputPath, options) { return addon.encodeAudio(pcm, outputPath, options) }
    transcodeAudio(inputPath, outputPath, options) { return addon.transcodeAudio(inputPath, outputPath, options) }
    thumbnail(inputPath, options) { return addon.thumbnail(inputPath, options) }
    version() { return addon.version() }
    silkVersion() { return addon.silkVersion() }
  }

  ctx.plugin(FFmpegService)
}
