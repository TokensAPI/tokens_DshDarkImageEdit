import type { ImageEditModel } from '../shared/media.js'

export interface GeneratedImage {
  url: string
  attachmentId?: string
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
  name?: string
  error?: string
}

export interface MediaConfig {
  baseURL: string
  apiKeyEnv: string
  pollIntervalMs: number
  maxPollMs: number
  allowLocalImageInput: boolean
  maxInputImageBytes: number
  imageUploadURL: string
  uploadAuthMode: 'account' | 'api_key'
  accountAccessTokenEnv: string
  accountUserId: string
  defaultEditModel: ImageEditModel
}
