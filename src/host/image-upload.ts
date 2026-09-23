export type ImageUploadProtocol = 'assets-v1' | 'legacy-presign'

export interface ImageUploadGrant {
  uploadUrl: string
  accessUrl: string
  uploadMethod: string
  requiredHeaders: Record<string, string>
  uploadExpiresAt?: number
  protocol: ImageUploadProtocol
}

export interface ImageUploadValidationOptions {
  mimeType: string
  byteLength: number
  nowSeconds?: number
  minimumValiditySeconds?: number
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const FORBIDDEN_UPLOAD_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
])

interface ParsedUploadPayload {
  protocol: ImageUploadProtocol
  value: Record<string, unknown>
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function apiErrorMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
  const error = objectValue(payload.error)
  if (typeof error?.message === 'string' && error.message.trim()) {
    const code = typeof error.code === 'string' && error.code.trim() ? `${error.code.trim()}: ` : ''
    return `${code}${error.message.trim()}`
  }
  return undefined
}

function uploadPayload(payload: Record<string, unknown>): ParsedUploadPayload {
  if ('upload_url' in payload || 'access_url' in payload || 'required_headers' in payload) {
    return { protocol: 'assets-v1', value: payload }
  }
  const legacy = objectValue(payload.data)
  if (payload.success === true && legacy) return { protocol: 'legacy-presign', value: legacy }
  const detail = apiErrorMessage(payload)
  throw new Error(`TokensAPI image upload response is invalid${detail ? `: ${detail}` : '.'}`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`TokensAPI image upload response is missing ${field}.`)
  }
  return value.trim()
}

function uploadHeaders(value: unknown, protocol: ImageUploadProtocol): Record<string, string> {
  if (value === undefined && protocol === 'legacy-presign') return {}
  const record = objectValue(value)
  if (!record) throw new Error('TokensAPI image upload response has invalid required_headers.')
  const entries = Object.entries(record)
  if (entries.some(([name, headerValue]) => !name.trim() || typeof headerValue !== 'string')) {
    throw new Error('TokensAPI image upload response has invalid required_headers.')
  }
  return Object.fromEntries(entries.map(([name, headerValue]) => [name, String(headerValue)]))
}

function uploadExpiry(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error('TokensAPI image upload response has invalid upload_expires_at.')
  }
  return value
}

export function parseImageUploadGrant(payload: unknown): ImageUploadGrant {
  const root = objectValue(payload)
  if (!root) throw new Error('TokensAPI image upload response is invalid.')
  const parsed = uploadPayload(root)
  return {
    uploadUrl: requiredString(parsed.value.upload_url, 'upload_url'),
    accessUrl: requiredString(parsed.value.access_url, 'access_url'),
    uploadMethod: parsed.protocol === 'legacy-presign'
      ? typeof parsed.value.upload_method === 'string' && parsed.value.upload_method.trim()
        ? parsed.value.upload_method.trim()
        : 'PUT'
      : requiredString(parsed.value.upload_method, 'upload_method'),
    requiredHeaders: uploadHeaders(parsed.value.required_headers, parsed.protocol),
    uploadExpiresAt: uploadExpiry(parsed.value.upload_expires_at),
    protocol: parsed.protocol,
  }
}

function validateHttpsUrl(value: string, field: 'upload_url' | 'access_url'): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`TokensAPI image upload response has invalid ${field}.`)
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error(`TokensAPI image upload response ${field} must use HTTPS.`)
  }
  if (url.username || url.password) {
    throw new Error(`TokensAPI image upload response ${field} must not contain credentials.`)
  }
}

function validateLocalImage(mimeType: string, byteLength: number): string {
  const normalizedMimeType = mimeType.trim().toLowerCase()
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    throw new Error(`TokensAPI image upload does not support ${mimeType || 'an empty MIME type'}.`)
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`TokensAPI image upload size must be between 1 and ${MAX_IMAGE_BYTES} bytes.`)
  }
  return normalizedMimeType
}

function validatedHeaders(headers: Record<string, string>): {
  headers: Record<string, string>
  byLowerName: Map<string, string>
} {
  const result: Record<string, string> = {}
  const byLowerName = new Map<string, string>()
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim()
    const lowerName = name.toLowerCase()
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(rawValue)) {
      throw new Error('TokensAPI image upload response contains an invalid required header.')
    }
    if (byLowerName.has(lowerName)) {
      throw new Error(`TokensAPI image upload response contains duplicate required header ${name}.`)
    }
    if (FORBIDDEN_UPLOAD_HEADERS.has(lowerName)) {
      throw new Error(`TokensAPI image upload response must not require sensitive header ${name}.`)
    }
    byLowerName.set(lowerName, rawValue)
    result[name] = rawValue
  }
  return { headers: result, byLowerName }
}

function validateContentLength(value: string | undefined, byteLength: number, required: boolean): void {
  if (value === undefined) {
    if (required) throw new Error('TokensAPI image upload response is missing required Content-Length.')
    return
  }
  const trimmed = value.trim()
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error('TokensAPI image upload response has invalid Content-Length.')
  }
  if (Number(trimmed) !== byteLength) {
    throw new Error(`Signed Content-Length ${trimmed} does not match the local image size ${byteLength}.`)
  }
}

function validateContentType(value: string | undefined, mimeType: string, required: boolean): void {
  if (value === undefined) {
    if (required) throw new Error('TokensAPI image upload response is missing required Content-Type.')
    return
  }
  if (value.trim().toLowerCase() !== mimeType) {
    throw new Error(`Signed Content-Type ${value.trim() || '(empty)'} does not match the local image type ${mimeType}.`)
  }
}

function validateExpiry(grant: ImageUploadGrant, nowSeconds: number, minimumValiditySeconds: number): void {
  if (grant.uploadExpiresAt === undefined) return
  if (grant.uploadExpiresAt <= nowSeconds) {
    throw new Error('TokensAPI image upload URL has expired.')
  }
  if (grant.uploadExpiresAt - nowSeconds < minimumValiditySeconds) {
    throw new Error('TokensAPI image upload URL expires too soon to start the upload safely.')
  }
}

export function validateImageUploadGrant(
  grant: ImageUploadGrant,
  options: ImageUploadValidationOptions,
): ImageUploadGrant {
  const mimeType = validateLocalImage(options.mimeType, options.byteLength)
  validateHttpsUrl(grant.uploadUrl, 'upload_url')
  validateHttpsUrl(grant.accessUrl, 'access_url')
  if (grant.uploadMethod !== 'PUT') {
    throw new Error(`TokensAPI image upload method must be PUT, received ${grant.uploadMethod || '(empty)'}.`)
  }
  const checked = validatedHeaders(grant.requiredHeaders)
  const strict = grant.protocol === 'assets-v1'
  validateContentLength(checked.byLowerName.get('content-length'), options.byteLength, strict)
  validateContentType(checked.byLowerName.get('content-type'), mimeType, strict)
  validateExpiry(
    grant,
    options.nowSeconds ?? Math.floor(Date.now() / 1000),
    options.minimumValiditySeconds ?? 5,
  )
  if (!strict && !checked.byLowerName.has('content-type')) checked.headers['Content-Type'] = mimeType
  return {
    ...grant,
    requiredHeaders: checked.headers,
  }
}
