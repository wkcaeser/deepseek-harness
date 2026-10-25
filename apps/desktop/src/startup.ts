/**
 * Login-item registration and the recognition of a login launch.
 *
 * The shell registers itself with the operating system's login items and marks
 * those launches with a dedicated argument. Reading the argument back is what
 * lets a login launch stay out of the way while a launch the user asked for
 * still raises a window.
 *
 * macOS cannot use that argument: Electron's `args` option is Windows-only, and
 * the macOS 13+ implementation registers through `SMAppService`, which starts the
 * primary application without any command line. A login launch is recognised there
 * by `wasOpenedAtLogin` instead, with the age of the GUI session as a fallback.
 * `describeDesktopLaunchSignals` records every signal the decision could use, so a
 * wrong guess is visible instead of silent.
 */

import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import { writeDesktopStartupSettings, type DesktopStartupSettings } from './settings.ts'

/** Command-line marker stored in the login item; the shell reads it back on the next login launch. */
export const DESKTOP_LOGIN_ITEM_ARG = '--dsh-login-item'

/**
 * Debug override that forces a quiet start without rebooting, so the tray and the
 * hidden-start path can be exercised on demand. Never set by the login item itself.
 */
export const DESKTOP_SILENT_DEBUG_ARG = '--dsh-silent'

/**
 * A launch this soon after the session began is treated as a login launch.
 * Only a fallback: measured on macOS 13+ a login launch reports `wasOpenedAtLogin`,
 * so the window exists to cover an unusually slow login, not to lead the decision.
 */
const SESSION_START_WINDOW_SECONDS = readSessionStartWindowSeconds()

function readSessionStartWindowSeconds(): number {
  const value = Number(process.env.DSH_DESKTOP_LOGIN_LAUNCH_WINDOW_SECONDS)
  return Number.isSafeInteger(value) && value > 0 ? value : 60
}

/** What the operating system lets the shell promise about its own launch. */
export interface DesktopStartupCapabilities {
  /** Whether the operating system can start the shell at login through Electron's login items. */
  readonly launchAtLogin: boolean
  /** Whether a login launch may stay hidden; it needs a tray as the way back. */
  readonly startSilently: boolean
}

/** Nothing is promised on a platform whose login items Electron does not write. */
const NO_STARTUP_CAPABILITIES: DesktopStartupCapabilities = { launchAtLogin: false, startSilently: false }

/**
 * Which of the startup preferences the platform can actually honour.
 *
 * Electron implements login items on Windows and macOS only, and the tray that a quiet start
 * leaves behind ships on those two platforms only. A platform without either gets neither
 * toggle, so the menu never offers a promise the operating system would silently drop.
 * @param platform - Platform to evaluate; defaults to the running one.
 * @returns The supported preferences.
 */
export function resolveDesktopStartupCapabilities(
  platform: NodeJS.Platform = process.platform,
): DesktopStartupCapabilities {
  if (platform !== 'win32' && platform !== 'darwin') return NO_STARTUP_CAPABILITIES
  return { launchAtLogin: true, startSilently: true }
}

/** Every observable fact about how this launch came to be; diagnostics for the login-launch decision. */
export interface DesktopLaunchSignals {
  readonly platform: NodeJS.Platform
  /** Command line as the shell sees it; the login-item marker lands here on Windows only. */
  readonly argv: readonly string[]
  /** Name of the parent process; `loginwindow` means the session pulled the shell in. */
  readonly parentProcess: string | undefined
  /** Seconds since the GUI session began, when the platform reports it. */
  readonly secondsSinceSessionStart: number | undefined
  /** Electron's own hint, which the macOS 13+ `SMAppService` path does not populate reliably. */
  readonly wasOpenedAtLogin: boolean | undefined
  /** macOS login-item registration state; `enabled` means the system will launch the shell. */
  readonly loginItemStatus: string | undefined
}

/**
 * Read the name of the parent process, without the leading path.
 * Only answers on macOS, where the login launch is told apart by ancestry.
 */
function readParentProcessName(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const name = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim()
    return name === '' ? undefined : name.split('/').pop()
  } catch {
    return undefined
  }
}

/**
 * Read how long the GUI session has been running, from the `loginwindow` process.
 * That process lives for the whole session, so its age approximates the session age.
 */
function readSecondsSinceSessionStart(): number | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const [pid] = execFileSync('/usr/bin/pgrep', ['-x', 'loginwindow'], { encoding: 'utf8' }).trim().split('\n')
    if (pid === undefined || pid === '') return undefined
    const elapsed = execFileSync('/bin/ps', ['-o', 'etime=', '-p', pid], { encoding: 'utf8' }).trim()
    // etime reports [[dd-]hh:]mm:ss.
    const parts = elapsed.split('-')
    const days = parts.length > 1 ? Number(parts[0]) : 0
    const clock = parts.length > 1 ? (parts[1] ?? elapsed) : elapsed
    const segments = clock.split(':').map(Number)
    if (segments.some(Number.isNaN) || Number.isNaN(days)) return undefined
    return segments.reduce((total, segment) => total * 60 + segment, 0) + days * 86400
  } catch {
    return undefined
  }
}

/**
 * Collect the macOS signals a login-launch decision can use.
 * Answers nothing outside a packaged macOS shell: an unpacked or test run has no
 * meaningful ancestry, and reading it there would only mislead.
 *
 * Process ancestry is deliberately not one of them: measured on macOS 13+ a login
 * launch arrives from `launchd`, exactly like a manual one, so `loginwindow` never
 * appears as the parent. `Electron` reports the launch itself through
 * `wasOpenedAtLogin`, which distinguishes the two reliably.
 */
function macLoginLaunchEvidence(): { wasOpenedAtLogin: boolean; sessionAgeSeconds: number | undefined } | undefined {
  if (process.platform !== 'darwin' || !app.isPackaged) return undefined
  let wasOpenedAtLogin = false
  try {
    wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin
  } catch {
    // A launch must keep its default rather than fail here.
  }
  return { wasOpenedAtLogin, sessionAgeSeconds: readSecondsSinceSessionStart() }
}

/**
 * Everything observable about how this launch came to be.
 * Diagnostics only: call it once per process and log the result, so a decision that
 * guesses wrong leaves the evidence behind instead of failing invisibly.
 */
export function describeDesktopLaunchSignals(): DesktopLaunchSignals {
  let status: string | undefined
  let wasOpenedAtLogin: boolean | undefined
  try {
    const settings = app.getLoginItemSettings()
    status = settings.status
    wasOpenedAtLogin = settings.wasOpenedAtLogin
  } catch {
    // Diagnostics must never be the reason a launch fails.
  }
  return {
    platform: process.platform,
    argv: process.argv,
    parentProcess: readParentProcessName(),
    secondsSinceSessionStart: readSecondsSinceSessionStart(),
    wasOpenedAtLogin,
    loginItemStatus: status,
  }
}

/**
 * Whether this process was started by the registered login item.
 *
 * Windows carries the stored marker in the command line. macOS 13 registers through
 * `SMAppService`, which launches without a command line, so there the decision rests
 * on `wasOpenedAtLogin`, which Electron reports for a login launch under that API and
 * withholds for one the user asked for. The session-start window only catches a login
 * launch whose session managed to age past the marker before it was read.
 */
export function isDesktopLoginItemLaunch(): boolean {
  if (process.argv.includes(DESKTOP_LOGIN_ITEM_ARG)) return true
  const evidence = macLoginLaunchEvidence()
  if (evidence === undefined) return false
  return evidence.wasOpenedAtLogin
    || (evidence.sessionAgeSeconds !== undefined && evidence.sessionAgeSeconds <= SESSION_START_WINDOW_SECONDS)
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
 * The debug argument bypasses the stored preference so the hidden-start path can be
 * exercised without rebooting.
 * @param startup - Resolved startup preferences.
 * @param trayAvailable - Whether the platform shipped the always-present tray entry.
 */
export function isDesktopSilentStart(startup: DesktopStartupSettings, trayAvailable: boolean): boolean {
  if (trayAvailable && process.argv.includes(DESKTOP_SILENT_DEBUG_ARG)) return true
  return startup.startSilently && trayAvailable && isDesktopLoginItemLaunch()
}
