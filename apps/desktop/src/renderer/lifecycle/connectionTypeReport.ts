import * as Sentry from '@sentry/electron/renderer'
import { transferStore } from '@ruqa/domain'
import { isCrashReportingEnabled } from './crashReportingStorage'

/**
 * Каким путём реально шла передача — прямым или через ретранслятор.
 *
 * Отдельной аналитики в приложении нет и заводить её без спроса нельзя,
 * поэтому значение едет тем каналом, на который пользователь уже согласился:
 * тегом и крошкой в отчёте о сбое. Этого хватает, чтобы понять, в каких сетях
 * пробивка не удаётся, и не хватает, чтобы считать долю релейных передач —
 * для доли нужна продуктовая метрика и отдельное согласие.
 */
export function startConnectionTypeReport(): () => void {
  let last: string | null = null

  return transferStore.subscribe((state) => {
    const connectionType = state.connectionType
    if (connectionType === last) return
    last = connectionType
    if (!connectionType || !isCrashReportingEnabled()) return

    Sentry.setTag('connection_type', connectionType)
    Sentry.addBreadcrumb({
      category: 'transfer',
      level: 'info',
      message: `connection: ${connectionType}`
    })
  })
}
