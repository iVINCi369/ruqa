import type { ReactNode, DragEventHandler } from 'react'

// Raw <div> because react-strict-dom's html.div doesn't expose drag events.
export interface DragSurfaceProps {
  children: ReactNode
  // Растягивает поверхность на высоту родителя: так ронять файл можно в любое
  // место рабочей области, а не только в карточку по центру.
  fill?: boolean
  onDragLeave?: DragEventHandler<HTMLDivElement>
  onDragOver?: DragEventHandler<HTMLDivElement>
  onDrop?: DragEventHandler<HTMLDivElement>
}

export function DragSurface({
  children,
  fill = false,
  onDragLeave,
  onDragOver,
  onDrop
}: DragSurfaceProps) {
  return (
    <div
      style={fill ? { display: 'flex', flexDirection: 'column', height: '100%' } : undefined}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
    </div>
  )
}
