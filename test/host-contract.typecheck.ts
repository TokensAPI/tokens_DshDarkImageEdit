/// <reference lib="dom" />
import type { ComposerAttachmentsOwnerProps, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

type HostAttachmentPort = Assert<Equal<ComposerAttachmentsOwnerProps['onAddFiles'], (files: readonly File[]) => void>>
type HostRemovalPort = Assert<Equal<ComposerAttachmentsOwnerProps['onRemoveAttachment'], (id: DraftAttachmentId) => void>>
type HostDropGate = Assert<Equal<ComposerAttachmentsOwnerProps['canAcceptDrop'], boolean>>

export type HostComposerContract = HostAttachmentPort & HostRemovalPort & HostDropGate
