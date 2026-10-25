/**
 * Local Electron shell settings, loaded once per process independently of the Host.
 * Ownership: .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Launch behaviour of the shell itself: login-item registration and whether that launch raises a window. */
export interface DesktopStartupSettings {
  /** Register the shell with the operating system's login items. */
  readonly launchAtLogin: boolean
  /** Start a login-item launch without showing a window; the tray stays as the way back. */
  readonly startSilently: boolean
}

/** Resolved shell preferences; absent fields use the defaults without rewriting existing files. */
export interface DesktopSettings {
  readonly updates: {
    readonly allowTestAuthPopupWindow: boolean
  }
  readonly startup: DesktopStartupSettings
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read shell settings, creating the default document exclusively when missing.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @returns Validated settings, or defaults when reading, creating or validating fails; changes require a restart.
 */
export function readDesktopSettings(userData: string): DesktopSettings {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  const defaults: DesktopSettings = {
    updates: { allowTestAuthPopupWindow: false },
    startup: { launchAtLogin: false, startSilently: false },
  }
  try {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
        // An existing document belongs to the user, including one created during initialization.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      raw = readFileSync(path, 'utf8')
    }
    const value: unknown = JSON.parse(raw)
    if (!record(value) || (value.updates !== undefined && !record(value.updates))
      || (value.startup !== undefined && !record(value.startup))) {
      throw new Error('expected a JSON object with optional updates and startup objects')
    }
    const allow = value.updates?.allowTestAuthPopupWindow
    if (allow !== undefined && typeof allow !== 'boolean') {
      throw new Error('updates.allowTestAuthPopupWindow must be true or false')
    }
    const launchAtLogin = value.startup?.launchAtLogin
    const startSilently = value.startup?.startSilently
    if (launchAtLogin !== undefined && typeof launchAtLogin !== 'boolean') {
      throw new Error('startup.launchAtLogin must be true or false')
    }
    if (startSilently !== undefined && typeof startSilently !== 'boolean') {
      throw new Error('startup.startSilently must be true or false')
    }
    return {
      updates: { allowTestAuthPopupWindow: allow ?? false },
      startup: { launchAtLogin: launchAtLogin ?? false, startSilently: startSilently ?? false },
    }
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: using defaults because settings could not be loaded`, error)
    } catch (_logError) {
      // Diagnostic output is best effort; its failure must not make optional settings fatal.
      // TODO: Persist settings diagnostics when console output is unavailable, without blocking startup.
    }
    return defaults
  }
}

/**
 * Persist the startup preferences, leaving every other field of the user's document untouched.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @param startup - Launch behaviour to store.
 */
export function writeDesktopStartupSettings(userData: string, startup: DesktopStartupSettings): void {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  const document: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (record(value)) Object.assign(document, value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Unknown keys survive: the document belongs to the user and may hold fields this build ignores.
  document.startup = { ...(record(document.startup) ? document.startup : {}), ...startup }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
}
