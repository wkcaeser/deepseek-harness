import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  DESKTOP_LOGIN_ITEM_ARG,
  isDesktopLoginItemLaunch,
  isDesktopSilentStart,
  syncDesktopLoginItem,
  updateDesktopStartup,
} from '../src/startup.ts'
import type { DesktopStartupSettings } from '../src/settings.ts'

const electron = await vi.hoisted(async () => ({
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
}))
vi.mock('electron', () => ({ app: electron }))

const originalArgv = process.argv
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); electron.setLoginItemSettings.mockReset() })
afterEach(() => {
  vi.restoreAllMocks()
  process.argv = originalArgv
  electron.getLoginItemSettings.mockReset()
  electron.getLoginItemSettings.mockImplementation(() => ({ openAtLogin: false }))
})

function userData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-startup-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

it('recognises a login launch only by the marker stored in the login item', () => {
  process.argv = ['/app/DeepSeek Harness.exe']
  expect(isDesktopLoginItemLaunch()).toBe(false)
  process.argv = ['/app/DeepSeek Harness.exe', DESKTOP_LOGIN_ITEM_ARG]
  expect(isDesktopLoginItemLaunch()).toBe(true)
})

it('goes quiet only for a login launch that also asked to stay hidden and has a tray to return to', () => {
  const hidden: DesktopStartupSettings = { launchAtLogin: true, startSilently: true }
  process.argv = ['/app/DeepSeek Harness.exe', DESKTOP_LOGIN_ITEM_ARG]
  expect(isDesktopSilentStart(hidden, true)).toBe(true)
  // An explicit launch is a request to see the application.
  process.argv = ['/app/DeepSeek Harness.exe']
  expect(isDesktopSilentStart(hidden, true)).toBe(false)
  process.argv = ['/app/DeepSeek Harness.exe', DESKTOP_LOGIN_ITEM_ARG]
  expect(isDesktopSilentStart({ launchAtLogin: true, startSilently: false }, true)).toBe(false)
  // Without a tray, a hidden start would strand the running Host with no way back.
  expect(isDesktopSilentStart(hidden, false)).toBe(false)
})

it('leaves the login item alone while the registration already agrees', () => {
  electron.getLoginItemSettings.mockImplementation(() => ({ openAtLogin: true }))
  syncDesktopLoginItem(true)
  expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
})

it('registers the login item with the marker that identifies the next login launch', () => {
  syncDesktopLoginItem(true)
  expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
    openAtLogin: true, args: [DESKTOP_LOGIN_ITEM_ARG],
  })
})

it('unregisters without leaving the marker behind', () => {
  electron.getLoginItemSettings.mockImplementation(() => ({ openAtLogin: true }))
  syncDesktopLoginItem(false)
  expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, args: [] })
})

it('keeps starting when the operating system refuses the login item', () => {
  const failure = new Error('login items unavailable')
  electron.getLoginItemSettings.mockImplementation(() => { throw failure })
  expect(() => { syncDesktopLoginItem(true) }).not.toThrow()
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('login item'), failure)
})

it('stores a toggled preference and returns the applied pair even when saving fails', () => {
  const directory = userData()
  const next = updateDesktopStartup(directory, { launchAtLogin: false, startSilently: false }, { launchAtLogin: true })
  expect(next).toEqual({ launchAtLogin: true, startSilently: false })
  expect(JSON.parse(readFileSync(join(directory, 'desktop', 'settings.json'), 'utf8')).startup)
    .toEqual({ launchAtLogin: true, startSilently: false })
  expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
    openAtLogin: true, args: [DESKTOP_LOGIN_ITEM_ARG],
  })
})
