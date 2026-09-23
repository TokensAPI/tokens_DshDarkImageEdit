import { detectImageMediaType, extensionForMediaType, sanitizeTaskId } from '../shared/media.js'
import type { GeneratedImage } from './types.js'

interface AttachmentService {
  saveImage(input: { data: Buffer; mediaType: string; name: string }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

export async function download(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType?: string }> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase(),
  }
}

export async function saveImages(
  urls: string[],
  taskId: string,
  attachments: AttachmentService | undefined,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  return Promise.all(urls.map(async (url, index) => {
    const result: GeneratedImage = { url }
    if (!attachments) return result
    try {
      const downloaded = await download(url, signal)
      const mediaType = detectImageMediaType(downloaded.bytes, downloaded.mediaType)
      if (!mediaType) throw new Error(`Unsupported generated image type from ${url}`)
      const name = `media_gen_${sanitizeTaskId(taskId)}_${index + 1}${extensionForMediaType(mediaType)}`
      const ref = await attachments.saveImage({ data: downloaded.bytes, mediaType, name })
      return {
        ...result,
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: ref.name,
      }
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) }
    }
  }))
}
