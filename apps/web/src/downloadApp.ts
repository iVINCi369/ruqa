import { downloadUrl } from '@ruqa/domain'

export function openDownload(): void {
  window.open(downloadUrl, '_blank', 'noopener,noreferrer')
}
