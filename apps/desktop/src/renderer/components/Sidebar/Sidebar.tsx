import {
  DownloadIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SendIcon,
  SlidersHorizontalIcon
} from '@ruqa/components/icons'
import { useTransferStore } from '@ruqa/domain'
import { useTranslation } from '@ruqa/locales'
import logoMarkOnLight from '../../../../../../assets/ruqa-logo-dark.png'
import logoMarkOnDark from '../../../../../../assets/ruqa-logo.png'
import { Button, ListItem, ThemeType, useTheme } from '@ruqa/components'
import { openSettingsPanel } from '../Settings'
import { bridgeApi } from '../../api/bridgeApi'

export type TransferTab = 'send' | 'receive'

export function Sidebar({
  collapsed,
  activeTab,
  onSelect,
  onToggleCollapsed
}: {
  collapsed: boolean
  activeTab: TransferTab
  onSelect: (tab: TransferTab) => void
  onToggleCollapsed: () => void
}) {
  const { t } = useTranslation(['common'])
  const { themeType } = useTheme()
  const role = useTransferStore((s) => s.role)
  const logoMark = themeType === ThemeType.Light ? logoMarkOnLight : logoMarkOnDark
  // Полосу под перетаскивание окна держим ровно такой, какой она нужна:
  // на macOS под ней светофор, на остальных системах это просто захват.
  const dragStripHeight = bridgeApi.platform() === 'darwin' ? 'h-11' : 'h-8'
  const toggleLabel = collapsed
    ? t('common:labels.expandSidebar')
    : t('common:labels.collapseSidebar')

  return (
    <aside
      className={`flex h-screen shrink-0 flex-col border-r border-border-primary bg-background-deep pb-4 transition-[width] duration-200 ease-out ${
        collapsed ? 'w-[56px]' : 'w-[204px]'
      }`}
    >
      <div className={`${dragStripHeight} shrink-0`} style={{ WebkitAppRegion: 'drag' }} />

      <div
        className={`flex shrink-0 items-center ${
          collapsed ? 'justify-center px-2' : 'justify-between gap-2 px-3'
        }`}
      >
        {!collapsed && (
          <img src={logoMark} alt='Ruqa' className='h-6 w-auto shrink-0 object-contain' />
        )}
        {collapsed ? (
          <ListItem
            icon={<PanelLeftOpenIcon size={17} />}
            label={toggleLabel}
            tooltip={toggleLabel}
            collapsed
            onClick={onToggleCollapsed}
          />
        ) : (
          <Button
            variant='ghost'
            iconOnly
            size='sm'
            aria-label={toggleLabel}
            tooltip={toggleLabel}
            tooltipSide='bottom'
            onClick={onToggleCollapsed}
            icon={<PanelLeftCloseIcon size={17} />}
          />
        )}
      </div>

      {collapsed && <div className='mx-2 mt-2 border-t border-border-primary' />}

      <nav
        className={`flex flex-col gap-0.5 ${collapsed ? 'items-center px-2 pt-2' : 'px-3 pt-5'}`}
        aria-label={t('common:labels.transferMode')}
      >
        <ListItem
          icon={<SendIcon size={18} />}
          label={t('common:labels.send')}
          tooltip={t('common:labels.send')}
          collapsed={collapsed}
          active={activeTab === 'send'}
          showDot={role === 'sender'}
          onClick={() => onSelect('send')}
        />
        <ListItem
          icon={<DownloadIcon size={18} />}
          label={t('common:labels.receive')}
          tooltip={t('common:labels.receive')}
          collapsed={collapsed}
          active={activeTab === 'receive'}
          showDot={role === 'receiver'}
          onClick={() => onSelect('receive')}
        />
      </nav>

      <div className='flex-1' />

      <div className={`flex flex-col gap-0.5 ${collapsed ? 'items-center px-2' : 'px-3'}`}>
        <ListItem
          icon={<SlidersHorizontalIcon size={18} />}
          label={t('common:labels.settings')}
          tooltip={t('common:labels.settings')}
          collapsed={collapsed}
          onClick={() => openSettingsPanel()}
        />
      </div>
    </aside>
  )
}
