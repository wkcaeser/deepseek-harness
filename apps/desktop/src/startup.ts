/**
 * Login-item registration and the recognition of a login launch.
 *
 * The shell registers itself with the operating system's login items and marks
 * those launches with a dedicated argument. Reading the argument back is what
 * lets a login launch stay out of the way while a launch the user asked for
 * still raises a window.
 */

import { app } from 'electron'
import { writeDesktopStartupSettings, type DesktopStartupSettings } from './settings.ts'

/** Command-line marker stored in the login item; the shell reads it back on the next login launch. */
export const DESKTOP_LOGIN_ITEM_ARG = '--dsh-login-item'

/**
 * Whether this process was started by the registered login item.
 * The argument is authoritative: `wasOpenedAtLogin` is a per-platform hint that Electron
 * derives from launch services, and it does not distinguish a login launch from a later
 * manual launch that happened before the operating system cleared its own bookkeeping.
 */
export function isDesktopLoginItemLaunch(): boolean {
  return process.argv.includes(DESKTOP_LOGIN_ITEM_ARG)
}

/**
 * Register or unregister the login item so the operating system matches the stored preference.
 * The write is skipped while the registration already agrees: launching is not a reason to
 * touch the login item list on every start, and a failed write must never block startup.
 * @param launchAtLogin - Whether the operating system should start the shell at login.
 */
export function syncDesktopLoginItem(launchAtLogin: boolean): void {
  try {
    if (app.getLoginItemSettings({ args: [DESKTOP_LOGIN_ITEM_ARG] }).openAtLogin === launchAtLogin) return
    app.setLoginItemSettings({
      openAtLogin: launchAtLogin,
      args: launchAtLogin ? [DESKTOP_LOGIN_ITEM_ARG] : [],
    })
  } catch (error) {
    console.warn('desktop startup: login item registration unavailable', error)
  }
}

/**
 * Store one startup preference, apply the login item, and report the resolved pair.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @param current - Startup preferences before the change.
 * @param change - The field to replace.
 * @returns The applied preferences, which are the stored ones even when a step failed.
 */
export function updateDesktopStartup(
  userData: string,
  current: DesktopStartupSettings,
  change: Partial<DesktopStartupSettings>,
): DesktopStartupSettings {
  const next: DesktopStartupSettings = { ...current, ...change }
  try {
    writeDesktopStartupSettings(userData, next)
  } catch (error) {
    console.warn('desktop startup: preferences could not be saved', error)
  }
  syncDesktopLoginItem(next.launchAtLogin)
  return next
}

/**
 * Whether this launch should run without raising a window.
 * Only a login launch goes quiet: an explicit launch is a request to see the application,
 * and a quiet start with no tray to come back from would strand the running Host.
 * @param startup - Resolved startup preferences.
 * @param trayAvailable - Whether the platform shipped the always-present tray entry.
 */
export function isDesktopSilentStart(startup: DesktopStartupSettings, trayAvailable: boolean): boolean {
  return startup.startSilently && trayAvailable && isDesktopLoginItemLaunch()
}
