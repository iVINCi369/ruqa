import type { DragEventHandler, ReactNode } from 'react'
import { html } from 'react-strict-dom'
import { CloudUploadIcon } from '../../icons'
import { DragSurface } from './DragSurface'
import { styles } from './styles'

export interface FileDropZoneProps {
  compact?: boolean
  description?: ReactNode
  // Без пунктирной карточки — подсказка висит в рабочей области как есть.
  frameless?: boolean
  // Занимает всю высоту родителя (имеет смысл вместе с frameless).
  fill?: boolean
  hasFiles?: boolean
  isDragging?: boolean
  onClick?: () => void
  onDragLeave?: DragEventHandler<HTMLDivElement>
  onDragOver?: DragEventHandler<HTMLDivElement>
  onDrop?: DragEventHandler<HTMLDivElement>
  readOnly?: boolean
  title: string
}

export function FileDropZone({
  description,
  frameless = false,
  fill = false,
  hasFiles = false,
  isDragging = false,
  onClick,
  onDragLeave,
  onDragOver,
  onDrop,
  readOnly = false,
  title
}: FileDropZoneProps) {
  return (
    <DragSurface fill={fill} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      <html.div
        aria-disabled={readOnly || undefined}
        onClick={readOnly ? undefined : onClick}
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        style={[
          styles.card,
          hasFiles && styles.cardHasFile,
          isDragging && styles.cardActive,
          frameless && styles.cardFrameless,
          frameless && isDragging && styles.cardFramelessActive,
          fill && styles.cardFill,
          readOnly && styles.cardReadOnly
        ]}
      >
        <html.div style={[styles.content, hasFiles && styles.contentHasFile]}>
          <html.div
            style={[
              styles.iconRing,
              hasFiles && styles.iconRingHasFile,
              isDragging && styles.iconRingActive
            ]}
          >
            <CloudUploadIcon size={hasFiles ? 22 : 26} />
          </html.div>

          <html.div style={styles.textStack}>
            <html.p style={[styles.title, hasFiles && styles.titleHasFile]}>{title}</html.p>
            {description ? (
              <html.p style={[styles.description, hasFiles && styles.descriptionHasFile]}>
                {description}
              </html.p>
            ) : null}
          </html.div>
        </html.div>
      </html.div>
    </DragSurface>
  )
}

export function DropZoneLink({ children }: { children: ReactNode }) {
  return <html.span style={styles.link}>{children}</html.span>
}
