import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

export const IMAGE_EDIT_MODELS = ['qwen_image'] as const
export type ImageEditModel = typeof IMAGE_EDIT_MODELS[number]
export const DEFAULT_EDIT_MODEL: ImageEditModel = 'qwen_image'

// 图片编辑支持的画面比例（对齐参考插件用于编辑的比例集合）。
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const

// 单次编辑最多接受的输入图数量（qwen_image 支持 0~3 张参考图）。
export const MAX_INPUT_IMAGES = 3

/**
 * 把 `image` 参数拆成输入图列表（逗号分隔的字符串或数组），最多 MAX_INPUT_IMAGES 张。
 * 空输入回退为最近一张用户上传图片。
 */
export function splitImageInputs(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return ['dsh-attachment:latest']
  const list = Array.isArray(input) ? input : String(input)
  const items = (Array.isArray(list) ? list : list.split(',')).map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (items.length === 0) return ['dsh-attachment:latest']
  if (items.length > MAX_INPUT_IMAGES) {
    throw new Error(`Image edit accepts at most ${MAX_INPUT_IMAGES} input images, got ${items.length}.`)
  }
  return items
}

const ASPECT_RATIO_VALUES: Record<string, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '21:9': 21 / 9,
}

export interface ResolvedImageInput {
  value: string
  mediaType?: string
  bytes?: number
  source: 'remote' | 'data' | 'file'
  rawBytes?: Uint8Array
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

const EXTENSION_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export function detectImageMediaType(bytes: Uint8Array, hint?: string): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (hint) {
    const normalized = hint.split(';', 1)[0]?.trim().toLowerCase()
    if (normalized && MIME_EXTENSIONS[normalized]) return normalized
  }
  return null
}

export function extensionForMediaType(mediaType: string): string {
  return MIME_EXTENSIONS[mediaType] ?? '.bin'
}

function decodePercentBytes(value: string): Buffer {
  const bytes: number[] = []
  for (let index = 0; index < value.length;) {
    if (value[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16))
      index += 3
    } else {
      const code = value.charCodeAt(index)
      if (code > 0x7f) throw new Error('Non-base64 image data URL must percent-encode binary bytes.')
      bytes.push(code)
      index += 1
    }
  }
  return Buffer.from(bytes)
}

export function normalizeDataUrl(value: string, maxBytes: number): ResolvedImageInput {
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) throw new Error('Invalid image data URL.')
  const declared = (match[1] ?? 'image/png').toLowerCase()
  const encoded = match[3] ?? ''
  const bytes = match[2]
    ? Buffer.from(encoded, 'base64')
    : decodePercentBytes(encoded)
  if (bytes.length === 0) throw new Error('Image data URL is empty.')
  if (bytes.length > maxBytes) throw new Error(`Image input exceeds the ${maxBytes} byte limit.`)
  const mediaType = detectImageMediaType(bytes, declared)
  if (!mediaType) throw new Error(`Unsupported image data type: ${declared}`)
  return {
    value: `data:${mediaType};base64,${bytes.toString('base64')}`,
    mediaType,
    bytes: bytes.length,
    source: 'data',
    rawBytes: bytes,
  }
}

export async function resolveImageInput(input: string, maxBytes: number): Promise<ResolvedImageInput> {
  const value = String(input).trim()
  if (/^https:\/\//i.test(value)) return { value, source: 'remote' }
  if (/^http:\/\//i.test(value)) throw new Error('Image URL must use HTTPS.')
  if (value.startsWith('data:')) return normalizeDataUrl(value, maxBytes)

  const info = await stat(value)
  if (!info.isFile()) throw new Error(`Image input is not a regular file: ${value}`)
  if (info.size > maxBytes) throw new Error(`Image input exceeds the ${maxBytes} byte limit.`)
  const bytes = await readFile(value)
  const mediaType = detectImageMediaType(bytes, EXTENSION_MIMES[extname(value).toLowerCase()])
  if (!mediaType) throw new Error(`Unsupported image file type: ${value}`)
  return {
    value: `data:${mediaType};base64,${bytes.toString('base64')}`,
    mediaType,
    bytes: bytes.length,
    source: 'file',
    rawBytes: bytes,
  }
}

/**
 * 从图片文件头解析宽高（仅元数据，不读取/分析像素内容）。
 * 支持 PNG / GIF / JPEG / WebP。解析失败返回 null。
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24) return null
  try {
    // PNG: 签名 8 字节 + IHDR（长度4 + 类型4 + 宽4 + 高4），宽高位于偏移 16/20。
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) }
    }
    // GIF: 偏移 6/8 的小端 16 位宽高。
    const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5])
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) }
    }
    // JPEG: 逐段扫描 SOF 标记。
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes)
    // WebP: RIFF/WEBP 容器。
    if (bytes.length >= 30 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF'
      && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') {
      return webpDimensions(bytes)
    }
  } catch {
    return null
  }
  return null
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 独立标记（SOI/EOI/RSTn）没有长度字段。
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const segmentLength = readUint16BE(bytes, offset + 2)
    if (segmentLength < 2) return null
    // 携带尺寸的 SOF 标记（baseline / extended / progressive 等）。
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      // SOF 数据：2 长度 + 1 精度 + 2 高 + 2 宽。
      if (offset + 9 > bytes.length) return null
      return { height: readUint16BE(bytes, offset + 5), width: readUint16BE(bytes, offset + 7) }
    }
    offset += 2 + segmentLength
  }
  return null
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (chunk === 'VP8X') {
    // 20: flags, 21-23: reserved, 24-26: width-1(LE), 27-29: height-1(LE)。
    const widthMinus1 = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)
    const heightMinus1 = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)
    return { width: widthMinus1 + 1, height: heightMinus1 + 1 }
  }
  if (chunk === 'VP8L') {
    // 20: 签名 0x2F, 21-24: 维度数据（4 字节小端）。
    const b0 = bytes[21]
    const b1 = bytes[22]
    const b2 = bytes[23]
    const b3 = bytes[24]
    const widthMinus1 = b0 | ((b1 & 0x3f) << 8)
    const heightMinus1 = (b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)
    return { width: widthMinus1 + 1, height: heightMinus1 + 1 }
  }
  if (chunk === 'VP8 ') {
    // 20-22: 帧标记, 23-24: 宽(14位 LE), 25-26: 高(14位 LE)。
    return {
      width: (bytes[23] | (bytes[24] << 8)) & 0x3fff,
      height: (bytes[25] | (bytes[26] << 8)) & 0x3fff,
    }
  }
  return null
}

/** 依据图片宽高选择最接近的支持比例。 */
export function closestAspectRatio(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1:1'
  const ratio = width / height
  let best: (typeof ASPECT_RATIOS)[number] = ASPECT_RATIOS[2]
  let bestDiff = Number.POSITIVE_INFINITY
  for (const candidate of ASPECT_RATIOS) {
    const diff = Math.abs((ASPECT_RATIO_VALUES[candidate] ?? 1) - ratio)
    if (diff < bestDiff) {
      bestDiff = diff
      best = candidate
    }
  }
  return best
}

export function resultUrls(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const results = (data as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  return results
    .map((item) => item && typeof item === 'object' ? (item as { url?: unknown }).url : undefined)
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
}

export function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, '_')
}
