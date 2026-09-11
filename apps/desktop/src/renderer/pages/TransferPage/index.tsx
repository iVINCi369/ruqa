import { useState } from 'react'
import { Settings, Sidebar, type TransferTab } from '../../components'
import { bridgeApi } from '../../api/bridgeApi'
import { isSidebarCollapsed, setSidebarCollapsed } from '../../lifecycle/sidebarStorage'
import { useNarrowWindow } from '../../lifecycle/useNarrowWindow'
import { ReceivePage, SendPage } from '..'

export default function TransferPage({
  version,
  activeTab,
  onTabChange
}: {
  version: string
  activeTab: TransferTab
  onTabChange: (tab: TransferTab) => void
}) {
  const [collapsed, setCollapsed] = useState(() => isSidebarCollapsed())
  const narrow = useNarrowWindow()
  const dragStripHeight = bridgeApi.platform() === 'darwin' ? 'h-11' : 'h-8'

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      setSidebarCollapsed(next)
      return next
    })
  }

  return (
    <div className='flex h-screen w-full bg-background text-text-primary'>
      <Sidebar
        collapsed={collapsed || narrow}
        activeTab={activeTab}
        onSelect={onTabChange}
        onToggleCollapsed={toggleCollapsed}
      />

      <main className='flex min-h-0 min-w-0 flex-1 flex-col'>
        <div className={`${dragStripHeight} w-full shrink-0`} style={{ WebkitAppRegion: 'drag' }} />

        <section className='flex min-h-0 flex-1 flex-col px-7 pb-5 pt-1 max-[820px]:px-4'>
          <div className='mx-auto flex min-h-0 w-full max-w-[880px] flex-1 flex-col'>
            {activeTab === 'send' ? <SendPage /> : <ReceivePage />}
          </div>
        </section>
      </main>

      <Settings version={version} />
    </div>
  )
}
