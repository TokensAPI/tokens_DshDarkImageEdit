import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash } from 'node:crypto'
import type { MediaConfig } from './types.js'
import { resultUrls } from '../shared/media.js'
import { parseImageUploadGrant, validateImageUploadGrant } from './image-upload.js'

type MediaTaskKind = 'images'

interface PendingSubmission {
  idempotencyKey: string
  taskId?: string
  updatedAt: number
}

class TokensApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'TokensApiHttpError'
  }
}

export interface TokensContext {
  credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
  logger: { warn(format: string, ...args: unknown[]): void }
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function responseTaskId(data: Record<string, unknown>): string | undefined {
  const nested = [data, data.data, data.error].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
  for (const value of nested) {
    for (const key of ['task_id', 'taskId', 'active_task_id', 'activeTaskId', 'existing_task_id', 'existingTaskId']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
  }
  return undefined
}

function responseErrorMessage(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.message === 'string' && data.message.trim()) return data.message
  const error = data.error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return String((error as { message: string }).message)
  }
  return fallback
}

function responseErrorCode(data: Record<string, unknown>): string | undefined {
  if (typeof data.code === 'string' && data.code.trim()) return data.code.trim()
  const error = data.error
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const code = String((error as { code: string }).code).trim()
    return code || undefined
  }
  return undefined
}

function imageUploadSigningError(response: Response, data: Record<string, unknown>): Error {
  const explanations: Record<number, string> = {
    400: 'The image upload signing request is invalid.',
    401: 'The configured TokensAPI API key is invalid or missing.',
    403: 'Image upload is not allowed for this user, organization, or IP.',
    413: 'The image exceeds the 30 MB upload limit.',
    429: 'Image upload signing was requested too frequently; wait before retrying.',
    503: 'TokensAPI image storage is unavailable.',
  }
  const explanation = explanations[response.status] ?? 'TokensAPI could not create an image upload URL.'
  const code = responseErrorCode(data)
  const serviceDetail = responseErrorMessage(data, response.statusText).trim()
  const suffix = [
    code ? `code=${code}` : '',
    serviceDetail && serviceDetail !== response.statusText ? serviceDetail : '',
  ].filter(Boolean).join('; ')
  return new Error(`TokensAPI image upload signing failed (${response.status}): ${explanation}${suffix ? ` ${suffix}` : ''}`)
}

function responseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export class TokensApiClient {
  private readonly pendingSubmissions = new Map<string, PendingSubmission>()

  constructor(private readonly ctx: TokensContext, private readonly config: MediaConfig) {}

  private async key(refName = this.config.apiKeyEnv): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (!resolved?.value) throw new Error(`${refName} is not configured in DSH credentials`)
    return resolved.value
  }

  private idempotencyKey(): string {
    return `dsh-dark-edit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  private submissionFingerprint(kind: MediaTaskKind, body: Record<string, unknown>): string {
    return sha256Hex(`${kind}\n${canonicalJson(body)}`)
  }

  private prunePendingSubmissions(): void {
    const expiry = Date.now() - Math.max(this.config.maxPollMs * 2, 30 * 60 * 1000)
    for (const [fingerprint, record] of this.pendingSubmissions) {
      if (record.updatedAt < expiry) this.pendingSubmissions.delete(fingerprint)
    }
  }

  private forgetTask(taskId: string): void {
    for (const [fingerprint, record] of this.pendingSubmissions) {
      if (record.taskId === taskId) this.pendingSubmissions.delete(fingerprint)
    }
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000)
    const factors = [1, 1.6, 2.6, 4, 6]
    const factor = factors[Math.min(attempt, factors.length - 1)] ?? 6
    return Math.min(30_000, Math.max(1, Math.round(this.config.pollIntervalMs * factor)))
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Generation cancelled')
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('Generation cancelled'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof TokensApiHttpError) return transientStatus(error.status)
    return error instanceof TypeError || (error instanceof Error && /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(error.message))
  }

  async uploadImage(dataUrl: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.imageUploadURL) throw new Error('TokensAPI image upload URL is not configured.')
    if (this.config.uploadAuthMode === 'account' && !this.config.accountUserId.trim()) {
      throw new Error('accountUserId is required for account-authenticated TokensAPI image upload.')
    }
    const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
    if (!match) throw new Error('First-party image upload requires a base64 Data URL.')
    const mediaType = match[1] ?? 'image/png'
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
      throw new Error(`TokensAPI image upload does not support ${mediaType}.`)
    }
    const bytes = Buffer.from(match[2] ?? '', 'base64')
    if (bytes.length === 0 || bytes.length > 30 * 1024 * 1024) throw new Error('TokensAPI image upload size must be between 1 byte and 30 MB.')
    const uploadCredentialRef = this.config.uploadAuthMode === 'api_key'
      ? this.config.apiKeyEnv
      : this.config.accountAccessTokenEnv
    const presignHeaders: Record<string, string> = {
      Authorization: `Bearer ${await this.key(uploadCredentialRef)}`,
      'Content-Type': 'application/json',
    }
    if (this.config.uploadAuthMode === 'account') presignHeaders['New-Api-User'] = this.config.accountUserId.trim()
    const presignResponse = await fetch(this.config.imageUploadURL, {
      method: 'POST',
      headers: presignHeaders,
      body: JSON.stringify({ mime_type: mediaType, file_size: bytes.length }),
      signal,
    })
    const presign = await presignResponse.json().catch(() => ({})) as Record<string, unknown>
    if (!presignResponse.ok) {
      throw imageUploadSigningError(presignResponse, presign)
    }
    const grant = validateImageUploadGrant(parseImageUploadGrant(presign), {
      mimeType: mediaType,
      byteLength: bytes.length,
    })
    // Cloudflare R2 presigned URLs sign the Host header. We must not send Host
    // explicitly (fetch derives it from the URL), but we verify the signed Host
    // matches the upload URL so the signature stays valid.
    const requiredHost = grant.requiredHeaders.host ?? grant.requiredHeaders.Host
    const uploadHeaders = { ...grant.requiredHeaders }
    delete uploadHeaders.host
    delete uploadHeaders.Host
    if (requiredHost) {
      const uploadHostname = new URL(grant.uploadUrl).hostname
      if (uploadHostname !== requiredHost) {
        throw new Error(`TokensAPI image upload requires Host ${requiredHost}, which does not match the upload URL host ${uploadHostname}.`)
      }
    }
    const uploadResponse = await fetch(grant.uploadUrl, {
      method: grant.uploadMethod,
      headers: uploadHeaders,
      body: bytes,
      redirect: 'error',
      signal,
    })
    if (!uploadResponse.ok) throw new Error(`TokensAPI object upload failed (${uploadResponse.status}): ${uploadResponse.statusText}`)
    return grant.accessUrl
  }

  async submit(
    kind: MediaTaskKind,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    deduplicationInput: Record<string, unknown> = body,
  ): Promise<string> {
    this.prunePendingSubmissions()
    const fingerprint = this.submissionFingerprint(kind, deduplicationInput)
    const existing = this.pendingSubmissions.get(fingerprint)
    if (existing?.taskId) {
      existing.updatedAt = Date.now()
      return existing.taskId
    }
    const record = existing ?? { idempotencyKey: this.idempotencyKey(), updatedAt: Date.now() }
    this.pendingSubmissions.set(fingerprint, record)
    let lastProblem = 'network interruption'
    const maxAttempts = 3
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new Error('Generation cancelled')
      let response: Response
      try {
        response = await fetch(`${this.config.baseURL}/tasks/${kind}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await this.key()}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': record.idempotencyKey,
          },
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new Error('Generation cancelled')
        if (!this.isTransientError(error)) {
          this.pendingSubmissions.delete(fingerprint)
          throw error
        }
        lastProblem = error instanceof Error ? error.message : String(error)
        record.updatedAt = Date.now()
        if (attempt + 1 < maxAttempts) {
          await this.wait(this.retryDelay(attempt), signal)
          continue
        }
        break
      }
      const data = await response.json().catch(() => ({})) as Record<string, unknown>
      const taskId = responseTaskId(data)
      if (taskId && (response.ok || response.status === 409 || response.status === 429)) {
        record.taskId = taskId
        record.updatedAt = Date.now()
        return taskId
      }
      if (response.ok && !taskId) {
        lastProblem = 'TokensAPI returned no task_id'
      } else if (!response.ok) {
        const detail = responseErrorMessage(data, response.statusText)
        lastProblem = `TokensAPI submit failed (${response.status}): ${detail}`
        if (!transientStatus(response.status)) {
          this.pendingSubmissions.delete(fingerprint)
          throw new TokensApiHttpError(lastProblem, response.status, responseRetryAfterMs(response))
        }
      }
      record.updatedAt = Date.now()
      if (attempt + 1 < maxAttempts) {
        await this.wait(this.retryDelay(attempt, responseRetryAfterMs(response)), signal)
      }
    }
    throw new Error(`TokensAPI submission status is uncertain after ${lastProblem}. Do not create a new task; retrying the same request will reuse idempotency key ${record.idempotencyKey}.`)
  }

  async status(taskId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.baseURL}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${await this.key()}` },
      signal,
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      throw new TokensApiHttpError(
        `TokensAPI status failed (${response.status}): ${responseErrorMessage(data, response.statusText)}`,
        response.status,
        responseRetryAfterMs(response),
      )
    }
    return data
  }

  async poll(taskId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.config.maxPollMs
    let lastData: Record<string, unknown> = { task_id: taskId, status: 'running', progress: 0 }
    let transientAttempts = 0
    for (;;) {
      if (signal?.aborted) throw new Error('Generation cancelled')
      let data: Record<string, unknown>
      try {
        data = await this.status(taskId, signal)
        lastData = data
        transientAttempts = 0
      } catch (error) {
        if (signal?.aborted) throw new Error('Generation cancelled')
        if (!this.isTransientError(error)) throw new Error(`Generation task ${taskId} status check failed: ${error instanceof Error ? error.message : String(error)}`)
        if (Date.now() > deadline) return { ...lastData, task_id: taskId, timedOut: true, recoverable: true }
        const retryAfterMs = error instanceof TokensApiHttpError ? error.retryAfterMs : undefined
        await this.wait(this.retryDelay(transientAttempts, retryAfterMs), signal)
        transientAttempts += 1
        continue
      }
      const status = typeof data.status === 'string' ? data.status : 'unknown'
      if (status === 'succeeded') {
        this.forgetTask(taskId)
        return data
      }
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        this.forgetTask(taskId)
        const errorValue = data.error
        const error = errorValue && typeof errorValue === 'object'
          ? ((errorValue as { message?: string; code?: string }).message ?? JSON.stringify(errorValue))
          : typeof errorValue === 'string' ? errorValue : status
        throw new Error(`Generation task ${taskId} failed: ${error}`)
      }
      if (Date.now() > deadline) return { ...data, task_id: taskId, timedOut: true, recoverable: true }
      await this.wait(this.config.pollIntervalMs, signal)
    }
  }

  urls(data: unknown): string[] {
    return resultUrls(data)
  }
}
