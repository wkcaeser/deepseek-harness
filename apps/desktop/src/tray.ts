/**
 * The always-present way back to a hidden window and the explicit quit entry:
 * the Windows notification area, or the macOS menu bar.
 */

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Main-process actions the tray triggers; both run the same paths as the window and application menu. */
export interface DesktopTrayOptions {
  /**
   * Multi-size ICO rendered by `scripts/render-tray-icon.ts`, which Windows scales by display,
   * or the PNG alpha mask rendered for the macOS menu bar.
   */
  readonly iconPath: string
  /** Treat the icon as a macOS template image, which the system tints to match the menu bar. */
  readonly template?: boolean
  readonly locale: () => DesktopLocale
  /** Items owned by the shell that belong above the quit entry; read again on every rebuild. */
  readonly extraItems: () => MenuItemConstructorOptions[]
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
}

/** Tray icon present for the whole run, not only while the window is hidden. */
export class DesktopTray {
  private tray: Tray | undefined

  /** @param options - Icon path, locale reader, and the open and quit actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    const image = nativeImage.createFromPath(options.iconPath)
    if (options.template === true) image.setTemplateImage(true)
    const tray = new Tray(image)
    this.tray = tray
    tray.on('click', () => { options.open() })
    this.relabel()
  }

  /** Rebuild the tooltip and context menu in the current locale. */
  relabel(): void {
    const tray = this.tray
    if (tray === undefined) return
    const { messages } = this.options.locale()
    tray.setToolTip(messages.aboutProduct)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => { this.options.open() } },
      ...this.options.extraItems(),
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    ]))
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
  }
}
