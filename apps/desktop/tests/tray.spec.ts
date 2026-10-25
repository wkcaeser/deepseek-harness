import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopTray } from '../src/tray.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const trays: FakeTray[] = []
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super(); trays.push(this) }
  }
  const menus: MenuItemConstructorOptions[][] = []
  /** Every template flag the shell has asked the system to honour, in order. */
  const templates: boolean[] = []
  return {
    trays, FakeTray, menus, templates,
    createFromPath: vi.fn((path: string) => ({
      path,
      setTemplateImage: vi.fn((flag: boolean) => { templates.push(flag) }),
    })),
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => { menus.push(template); return { template } }),
  }
})
vi.mock('electron', () => ({
  Tray: native.FakeTray,
  nativeImage: { createFromPath: native.createFromPath },
  Menu: { buildFromTemplate: native.buildFromTemplate },
}))

afterEach(() => {
  native.trays.length = 0
  native.menus.length = 0
  native.templates.length = 0
  vi.clearAllMocks()
})

function setup(locale = 'en', extraItems: () => MenuItemConstructorOptions[] = () => [], template = false) {
  let current = resolveDesktopLocale(locale)
  const open = vi.fn()
  const quit = vi.fn()
  const tray = new DesktopTray({ iconPath: 'C:/app/resources/tray.ico', template,
    locale: () => current, extraItems, open, quit })
  return { tray, open, quit, native: native.trays[0]!, setLocale: (next: string) => { current = resolveDesktopLocale(next) } }
}

function labels(menu: MenuItemConstructorOptions[]): (string | undefined)[] {
  return menu.map(item => item.type === 'separator' ? 'separator' : item.label)
}

it('shows the application icon with its name as the tooltip and an Open / Quit menu', () => {
  const f = setup()
  expect(native.createFromPath).toHaveBeenCalledWith('C:/app/resources/tray.ico')
  expect(f.native.image).toMatchObject({ path: 'C:/app/resources/tray.ico' })
  expect(f.native.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
  expect(labels(native.menus[0]!)).toEqual(['Open DeepSeek Harness', 'separator', 'Quit DeepSeek Harness'])
  expect(f.native.setContextMenu).toHaveBeenCalledWith({ template: native.menus[0] })
})

it('leaves a Windows tray icon its own colours and hands macOS one the system tints', () => {
  setup()
  // The notification area paints the bundled bitmaps as they are.
  expect(native.templates).toEqual([])
  setup('en', () => [], true)
  expect(native.templates).toEqual([true])
})

it('opens the window on a single click and routes menu entries to the open and quit actions', () => {
  const f = setup()
  f.native.emit('click')
  expect(f.open).toHaveBeenCalledOnce()
  const menu = native.menus[0]!
  ;(menu[0] as { click: () => void }).click()
  ;(menu[2] as { click: () => void }).click()
  expect(f.open).toHaveBeenCalledTimes(2)
  expect(f.quit).toHaveBeenCalledOnce()
})

it('places its own entries above the quit entry and reads them again on every rebuild', () => {
  let checked = false
  const click = vi.fn(() => { checked = true })
  const f = setup('en', () => [
    { type: 'separator' },
    { type: 'checkbox', label: 'Launch at Login', checked, click },
  ])
  expect(labels(native.menus[0]!)).toEqual([
    'Open DeepSeek Harness', 'separator', 'Launch at Login', 'separator', 'Quit DeepSeek Harness',
  ])
  ;(native.menus[0]![2] as { click: () => void }).click()
  expect(click).toHaveBeenCalledOnce()
  f.tray.relabel()
  // The rebuilt menu reflects the state the shell reached after the click.
  expect(native.menus[1]![2]).toMatchObject({ label: 'Launch at Login', checked: true })
})

it('relabels the menu in the current locale and ignores relabel after disposal', () => {
  const f = setup()
  f.setLocale('zh')
  f.tray.relabel()
  expect(labels(native.menus[1]!)).toEqual(['打开 DeepSeek Harness', 'separator', '退出 DeepSeek Harness'])
  f.tray.dispose()
  f.tray.dispose()
  expect(f.native.destroy).toHaveBeenCalledOnce()
  f.tray.relabel()
  expect(native.menus).toHaveLength(2)
})
