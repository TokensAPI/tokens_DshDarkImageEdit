import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  ASPECT_RATIOS,
  DEFAULT_EDIT_MODEL,
  IMAGE_EDIT_MODELS,
  MAX_INPUT_IMAGES,
  closestAspectRatio,
  imageDimensions,
  resolveImageInput,
  splitImageInputs,
} from '../shared/media.js'
import { saveImages } from './results.js'
import { TokensApiClient } from './tokensapi.js'
import type { GeneratedImage, MediaConfig } from './types.js'

export { TokensApiClient } from './tokensapi.js'
export { parseImageUploadGrant, validateImageUploadGrant } from './image-upload.js'
export type { ImageUploadGrant, ImageUploadProtocol, ImageUploadValidationOptions } from './image-upload.js'
export { closestAspectRatio, imageDimensions, MAX_INPUT_IMAGES, splitImageInputs } from '../shared/media.js'

type AnyRecord = Record<string, any>

export const name = 'dark-image-edit'
export const inject = ['tools', 'credentials', 'systemPrompt', 'attachments', 'webServer', 'userQuestions']

export const Config = Schema.object({
  baseURL: Schema.string().default('https://tokensapi.ai/v1'),
  apiKeyEnv: Schema.string().role('credential-ref').default('TOKENSAPI_API_KEY'),
  pollIntervalMs: Schema.number().default(5000),
  maxPollMs: Schema.number().default(12 * 60 * 1000),
  defaultEditModel: Schema.union([...IMAGE_EDIT_MODELS]).default(DEFAULT_EDIT_MODEL),
  allowLocalImageInput: Schema.boolean().default(true),
  maxInputImageBytes: Schema.number().default(30 * 1024 * 1024),
  imageUploadURL: Schema.string().default('https://tokensapi.ai/v1/assets/images'),
  uploadAuthMode: Schema.union(['account', 'api_key']).default('api_key'),
  accountAccessTokenEnv: Schema.string().role('credential-ref').default('TOKENSAPI_ACCOUNT_ACCESS_TOKEN'),
  accountUserId: Schema.string().default(''),
})

const DOWNLOAD_ROUTE = '/dark-image-edit/download'

function safeDownloadName(url: URL, requestedName: string | null): string {
  const fallback = url.pathname.split('/').pop() || 'media-download'
  const value = String(requestedName || fallback).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)
  return value || 'media-download'
}

function registerDownloadRoute(ctx: AnyRecord): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DOWNLOAD_ROUTE,
    async handler(req: AnyRecord, res: AnyRecord) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' })
        res.end()
        return
      }
      let source: URL
      let filename: string
      try {
        const requestUrl = new URL(req.url ?? DOWNLOAD_ROUTE, 'http://dsh.local')
        source = new URL(requestUrl.searchParams.get('url') || '')
        filename = safeDownloadName(source, requestUrl.searchParams.get('name'))
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (source.protocol !== 'https:' || source.hostname !== 's3.tokensapi.ai') {
        res.writeHead(403)
        res.end()
        return
      }
      try {
        const response = await fetch(source)
        if (!response.ok || !response.body) {
          res.writeHead(response.status || 502)
          res.end()
          return
        }
        const headers: Record<string, string> = {
          'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'private, max-age=300',
        }
        const length = response.headers.get('content-length')
        if (length) headers['Content-Length'] = length
        res.writeHead(200, headers)
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        Readable.fromWeb(response.body as any).pipe(res as any)
      } catch {
        res.writeHead(502)
        res.end()
      }
    },
  }), 'dark-image-edit: explicit download route')
}

function sessionUserImageRefs(exec: AnyRecord): AnyRecord[] {
  const messages = exec.agent?.session?.deriveMessages?.() ?? []
  const refs: AnyRecord[] = []
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'image' || !block.attachment || typeof block.attachment !== 'object') continue
      if (typeof block.attachment.attachmentId !== 'string') continue
      refs.push(block.attachment)
    }
  }
  return refs
}

function resolveSessionImageRef(exec: AnyRecord, selector: string): AnyRecord | null {
  const refs = sessionUserImageRefs(exec)
  if (refs.length === 0) return null
  if (!selector || selector === 'latest') return refs.at(-1) ?? null
  if (selector === 'first') return refs[0] ?? null
  if (selector === 'last') return refs.at(-1) ?? null
  const ordinal = /^(?:index:)?(\d+)$/.exec(selector)
  if (ordinal) {
    const position = Number(ordinal[1])
    if (!Number.isSafeInteger(position) || position < 1) return null
    return refs[position - 1] ?? null
  }
  const attachmentId = selector.startsWith('sha256:') ? selector : `sha256:${selector}`
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    if (refs[index]?.attachmentId === attachmentId) return refs[index] ?? null
  }
  return null
}

function describeSessionImageSelector(selector: string): string {
  if (!selector || selector === 'latest' || selector === 'last') return '当前对话最近一张用户上传图片'
  if (selector === 'first') return '当前对话第 1 张用户上传图片'
  const ordinal = /^(?:index:)?(\d+)$/.exec(selector)
  if (ordinal) return `当前对话第 ${Number(ordinal[1])} 张用户上传图片`
  return `当前对话附件 ${selector}`
}

function describeImageInput(input: unknown): string {
  const value = String(input ?? '')
  if (!value.startsWith('dsh-attachment:')) return value
  return describeSessionImageSelector(value.slice('dsh-attachment:'.length).trim() || 'latest')
}

interface PreparedImageInput {
  image: string
  width?: number
  height?: number
}

async function prepareInput(config: MediaConfig, api: TokensApiClient, input: unknown, exec: AnyRecord, attachments: AnyRecord): Promise<PreparedImageInput> {
  const trimmed = String(input ?? 'dsh-attachment:latest').trim()
  if (trimmed.startsWith('dsh-attachment:')) {
    if (!exec.agent) throw new Error('Chat attachment input requires a session-scoped tool call.')
    if (!attachments?.readImage) throw new Error('DSH attachment storage is unavailable.')
    const selector = trimmed.slice('dsh-attachment:'.length).trim() || 'latest'
    const ref = resolveSessionImageRef(exec, selector)
    if (!ref) {
      const count = sessionUserImageRefs(exec).length
      throw new Error(selector === 'latest'
        ? 'No user-uploaded image was found in the current conversation.'
        : `Image selector ${selector} did not match the current conversation's ${count} user-uploaded image(s). Use latest, first, last, a 1-based number, index:N, or a current-conversation attachment id.`)
    }
    const stored = await attachments.readImage(ref, exec.signal)
    if (!stored?.data) throw new Error('DSH attachment storage returned no image bytes.')
    if (stored.data.byteLength > config.maxInputImageBytes) throw new Error(`Image input exceeds the ${config.maxInputImageBytes} byte limit.`)
    const mediaType = stored.ref?.mediaType ?? ref.mediaType
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
      throw new Error(`Unsupported chat attachment image type: ${mediaType ?? 'unknown'}`)
    }
    const dataUrl = `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
    const image = await api.uploadImage(dataUrl, exec.signal)
    const dims = imageDimensions(new Uint8Array(stored.data))
    return { image, ...(dims ? dims : {}) }
  }
  if (!config.allowLocalImageInput && !/^https:\/\//i.test(trimmed)) {
    throw new Error('Local image input is disabled by plugin configuration.')
  }
  const resolved = await resolveImageInput(trimmed, config.maxInputImageBytes)
  if (resolved.source === 'remote') return { image: resolved.value }
  const image = await api.uploadImage(resolved.value, exec.signal)
  const dims = resolved.rawBytes ? imageDimensions(resolved.rawBytes) : null
  return { image, ...(dims ? dims : {}) }
}

function imageBlocks(images: GeneratedImage[], label: string, model: string, taskId: string): AnyRecord[] {
  const blocks: AnyRecord[] = []
  for (const image of images) {
    if (image.attachmentId && image.mediaType && image.bytes !== undefined && image.width !== undefined && image.height !== undefined) {
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...(image.name ? { name: image.name } : {}),
        },
      })
    }
  }
  const lines = [`${label} (${model}, task ${taskId})`]
  images.forEach((image, index) => {
    if (image.url) lines.push(`Image ${index + 1}: ${image.url}`)
    if (image.error) lines.push(`Image ${index + 1} attachment warning: ${image.error}`)
  })
  blocks.push({ type: 'text', text: lines.join('\n') })
  return blocks
}

function pendingTaskFields(data: AnyRecord): AnyRecord {
  return {
    timedOut: true,
    recoverable: true,
    status: typeof data.status === 'string' ? data.status : 'running',
    progress: typeof data.progress === 'number' ? data.progress : 0,
  }
}

function pendingTaskBlock(value: AnyRecord): AnyRecord | undefined {
  if (value.timedOut !== true) return undefined
  return {
    type: 'text',
    text: [
      `Task ${value.taskId} is still running (${value.progress ?? 0}%).`,
      'The task id has been retained. Use image_edit_status to continue checking; do not submit the generation again.',
    ].join('\n'),
  }
}

function imageOutputSchema(): AnyRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskId: { type: 'string', required: true },
      model: { type: 'string', required: true },
      timedOut: { type: 'boolean' },
      recoverable: { type: 'boolean' },
      status: { type: 'string' },
      progress: { type: 'integer' },
      images: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            attachmentId: { type: 'string' },
            mediaType: { type: 'string' },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            name: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
    },
  }
}

function validateEditArguments(args: AnyRecord): { model: string; aspectRatio?: string; n: number } {
  const model = args.model ?? DEFAULT_EDIT_MODEL
  if (!(IMAGE_EDIT_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Model ${model} is not supported for image editing. Choose one of: ${IMAGE_EDIT_MODELS.join(', ')}.`)
  }
  // aspect_ratio 可选：不传时由插件自动测量图片尺寸并选择最接近的比例。
  const aspectRatio = typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim() ? args.aspect_ratio.trim() : undefined
  if (aspectRatio !== undefined && !(ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new Error(`Aspect ratio ${aspectRatio} is not supported. Choose one of: ${ASPECT_RATIOS.join(', ')}.`)
  }
  const n = args.n ?? 1
  if (!Number.isInteger(n) || ![1, 2, 4].includes(n)) {
    throw new Error('Image count n must be 1, 2, or 4.')
  }
  return { model, aspectRatio, n }
}

const ASPECT_REFERENCE_LABELS = ['第一张', '第二张', '第三张']

/**
 * 多张输入图且未显式指定 aspect_ratio 时，询问用户输出图参考哪一张的尺寸。
 * 返回 0 基索引；用户未作答或服务不可用时回退为第一张（0）。
 */
async function askAspectReferenceIndex(ctx: AnyRecord, exec: AnyRecord, count: number): Promise<number> {
  const labels = ASPECT_REFERENCE_LABELS.slice(0, count)
  const questions = [{
    id: 'dark-image-edit.aspect-reference',
    header: '参考尺寸',
    question: '输出图参考哪张输入图的尺寸？',
    options: labels.map((label) => ({ label })),
    initialSelected: [labels[0]],
    multi_select: false,
  }]
  const response = await ctx.userQuestions.ask({
    questions,
    ...(exec.agent ? { agent: exec.agent } : {}),
    signal: exec.signal,
  })
  const answer = (Array.isArray(response?.answers) ? response.answers : [])[0]
  const selected = typeof answer?.custom === 'string' && answer.custom.trim()
    ? answer.custom.trim()
    : (Array.isArray(answer?.selected) ? answer.selected[0] : undefined)
  const index = labels.indexOf(String(selected ?? ''))
  return index >= 0 ? index : 0
}

export function apply(ctx: AnyRecord, config: MediaConfig): void {
  const api = new TokensApiClient(ctx as any, config)
  registerDownloadRoute(ctx)
  const attachments = ctx.get('attachments')
  const register = (spec: AnyRecord) => ctx.tools.register(defineTool(spec as any))

  ctx.systemPrompt.section({
    name: 'dark-image-edit',
    order: 200,
    text: `dark-image-edit is a fully private image editor. The uploaded image is an opaque black box: NEVER read, describe, summarize, transcribe, or analyze its content. Do not call any vision, OCR, or image-understanding tool on it, and never ask the user to describe their own image.

Flow, exactly this order, with no confirmations and no wizard:
1. Pick the target image(s) from the user's uploads (dsh-attachment:latest by default; use first / last / index:N / a 1-based number / an attachment id, or the given HTTPS URL / local path — never invent a local path or URL). For a multi-image edit, pass up to 3 sources comma-separated in image, e.g. "dsh-attachment:1,dsh-attachment:2"; the model receives them as reference_1..reference_3 in that order.
2. Take the user's edit instruction verbatim as the prompt. Do not enrich it with anything inferred from the image (you cannot see it).
3. Call image_edit once with the full parameters; it uploads, generates, and returns the edited image with a download button.

The plugin measures each image's width/height from file headers (metadata only) and picks the closest aspect ratio automatically — you do not need to inspect or reason about any image. For a multi-image edit without an explicit aspect_ratio, the plugin asks the user which image's dimensions to reference for the output ratio. Only pass aspect_ratio when the user explicitly requests a specific one.`,
  })

  register({
    name: 'image_edit',
    description: '用 qwen_image 编辑图片并返回编辑后的图片（DSH 附件 + 远程 URL），全程不读取图片内容。支持最多 3 张输入图。图片输入支持 dsh-attachment 选择器、HTTPS URL、本地路径与 data URL；默认使用当前对话最近一张用户上传图片。',
    parameters: {
      prompt: { type: 'string', required: true, description: '编辑指令（原样使用，不分析图片内容）。' },
      image: { type: 'string', description: `图片来源，可多个用逗号分隔（最多 ${MAX_INPUT_IMAGES} 个）：dsh-attachment:latest、first、last、1 基序号、index:N、当前会话附件 id、HTTPS URL、本地路径或 data URL。默认最近一张用户上传图片。` },
      aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS], description: '画面比例，可选。不传时插件自动测量第一张图片尺寸并选择最接近的比例。' },
      n: { type: 'integer', enum: [1, 2, 4], description: '生成数量，默认 1。' },
    },
    output: {
      schema: imageOutputSchema(),
      render: (_args: unknown, value: AnyRecord) => {
        const blocks = imageBlocks(value.images, 'Edited images', value.model, value.taskId)
        const pending = pendingTaskBlock(value)
        if (pending) blocks.push(pending)
        return blocks
      },
    },
    async execute(args: AnyRecord, exec: AnyRecord) {
      const { model, aspectRatio: explicitAspectRatio, n } = validateEditArguments(args)
      const inputs = splitImageInputs(args.image)
      const preparedList: PreparedImageInput[] = []
      for (const input of inputs) preparedList.push(await prepareInput(config, api, input, exec, attachments))
      let aspectRatio = explicitAspectRatio
      if (!aspectRatio) {
        // 多张输入图且未显式指定比例时，询问参考哪一张的尺寸；单张或不支持提问时取第一张。
        let referenceIndex = 0
        if (preparedList.length > 1 && ctx.userQuestions?.ask) {
          referenceIndex = await askAspectReferenceIndex(ctx, exec, preparedList.length)
        }
        const reference = preparedList[referenceIndex] ?? preparedList[0]
        aspectRatio = (reference?.width && reference?.height)
          ? closestAspectRatio(reference.width, reference.height)
          : '1:1'
      }
      const body = {
        model,
        prompt: args.prompt,
        n,
        aspect_ratio: aspectRatio,
        input_references: preparedList.map((prepared, index) => ({
          type: 'image_url',
          slot_name: `reference_${index + 1}`,
          image_url: { url: prepared.image },
        })),
      }
      const deduplicationInput = { ...args, model, aspect_ratio: aspectRatio, n, image: args.image ?? 'dsh-attachment:latest' }
      const taskId = await api.submit('images', body, exec.signal, deduplicationInput)
      const data = await api.poll(taskId, exec.signal)
      const timedOut = data.timedOut === true
      const images = timedOut ? [] : await saveImages(api.urls(data), taskId, attachments, exec.signal)
      if (!timedOut && images.length > 0) exec.concludeTurn()
      return { taskId, model, images, ...(timedOut ? pendingTaskFields(data) : {}) }
    },
  })

  register({
    name: 'image_edit_status',
    description: '查询并恢复一个超时的图像编辑任务。完成后图片会保存为 DSH 附件。',
    parameters: {
      task_id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          progress: { type: 'integer' },
          images: { type: 'array', items: imageOutputSchema().properties.images.items },
          error: { type: 'string' },
        },
      },
      render: (_args: unknown, value: AnyRecord) => {
        if (Array.isArray(value.images) && value.images.length) return imageBlocks(value.images, 'Recovered images', 'task result', value.taskId)
        return [{ type: 'text', text: [
          `Task ${value.taskId}: ${value.status} (progress ${value.progress ?? 0}%)`,
          ...(value.error ? [`Warning: ${value.error}`] : []),
        ].join('\n') }]
      },
    },
    async execute(args: AnyRecord, exec: AnyRecord) {
      const data = await api.status(args.task_id, exec.signal)
      const status = typeof data.status === 'string' ? data.status : 'unknown'
      const progress = typeof data.progress === 'number' ? data.progress : 0
      if (status !== 'succeeded') return { taskId: args.task_id, status, progress }
      const urls = api.urls(data)
      const images = await saveImages(urls, args.task_id, attachments, exec.signal)
      if (images.length > 0) exec.concludeTurn()
      return { taskId: args.task_id, status, progress, images }
    },
  })
}
