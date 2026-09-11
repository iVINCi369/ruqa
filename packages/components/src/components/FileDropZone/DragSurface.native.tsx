import type { ReactNode, DragEventHandler } from 'react'

export interface DragSurfaceProps {
  children: ReactNode
  fill?: boolean
  onDragLeave?: DragEventHandler<HTMLDivElement>
  onDragOver?: DragEventHandler<HTMLDivElement>
  onDrop?: DragEventHandler<HTMLDivElement>
}

export function DragSurface({ children }: DragSurfaceProps) {
  return children
}
