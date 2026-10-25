/**
 * Render the tray icons from the vector application artwork.
 *
 * Windows shows the icon at 16 logical pixels, so it picks one of the bundled bitmaps by
 * display scale. Each size is rasterized from the vector source separately instead of
 * downscaling one large bitmap, which keeps edges crisp at every scale.
 *
 * macOS tints a menu bar item instead, so it receives a template image: the whale alone as an
 * alpha mask, at the logical edge and its Retina double.
 *
 * The committed `resources/tray-windows.ico`, `resources/tray-darwin.png` and
 * `resources/tray-darwin@2x.png` are the outputs; rerun `pnpm run render:tray-icon`
 * in `apps/desktop` after changing a vector source.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Bitmap edge lengths bundled in the tray icon: 16 px at 100 % through 400 % display scale. */
export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64] as const

/** Vector source and committed output of the tray icon. */
export const TRAY_ICON_PATHS = {
  source: fileURLToPath(new URL('../resources/icon-windows.svg', import.meta.url)),
  output: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)),
  darwinSource: fileURLToPath(new URL('../resources/icon-macos.svg', import.meta.url)),
  darwinOutput: fileURLToPath(new URL('../resources/tray-darwin.png', import.meta.url)),
  darwinOutputRetina: fileURLToPath(new URL('../resources/tray-darwin@2x.png', import.meta.url)),
} as const

/**
 * Menu bar edges of the macOS tray icon: the logical size and its Retina double.
 * Electron loads the `@2x` file on a high-density display, matching how it treats app icons.
 */
export const DARWIN_TRAY_ICON_EDGES = { base: 22, retina: 44 } as const

/** Coordinate space of the vector source; sharp's SVG density is scaled against it. */
const SOURCE_EDGE = 1024
const SOURCE_DENSITY = 72
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_DIRECTORY_BYTES = 6
const ICON_ENTRY_BYTES = 16

/** One bitmap of an icon file. */
export interface IcoEntry {
  readonly size: number
  /** Complete PNG stream; Windows Vista and later read PNG-compressed entries directly. */
  readonly png: Buffer
}

/**
 * Pack PNG bitmaps into one ICO file.
 * @param entries - Bitmaps in ascending size; each PNG must be square with the declared edge.
 * @returns the ICO bytes.
 */
export function packIco(entries: readonly IcoEntry[]): Buffer {
  const header = Buffer.alloc(ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((entry, index) => {
    if (entry.size < 1 || entry.size > 256) throw new Error(`tray icon: unsupported bitmap edge ${String(entry.size)}`)
    const { width, height } = pngDimensions(entry.png)
    if (width !== entry.size || height !== entry.size) {
      throw new Error(`tray icon: bitmap ${String(index)} is ${String(width)}x${String(height)}, expected ${String(entry.size)}`)
    }
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    // 256 px is encoded as 0 in the one-byte edge fields.
    header.writeUInt8(entry.size % 256, at)
    header.writeUInt8(entry.size % 256, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(entry.png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, ...entries.map(entry => entry.png)])
}

/**
 * Read the bitmaps back out of one ICO file.
 * @param ico - Bytes written by {@link packIco} or another PNG-entry ICO producer.
 * @returns entries in directory order, each PNG checked against its declared edge.
 */
export function unpackIco(ico: Buffer): IcoEntry[] {
  if (ico.length < ICON_DIRECTORY_BYTES || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('tray icon: not an ICO file')
  }
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    const declared = ico.readUInt8(at)
    const size = declared === 0 ? 256 : declared
    const length = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    const png = ico.subarray(offset, offset + length)
    const { width, height } = pngDimensions(png)
    if (width !== size || height !== size) throw new Error(`tray icon: entry ${String(index)} declares ${String(size)} but holds ${String(width)}x${String(height)}`)
    return { size, png }
  })
}

/**
 * Rasterize the vector source at each tray size.
 * @param svg - SVG document with a 1024-unit square viewBox and a `tray-glyph` group.
 * @param sizes - Bitmap edges to render.
 * @returns PNG entries in the given order.
 */
export async function renderTrayIconEntries(svg: Buffer, sizes: readonly number[] = TRAY_ICON_SIZES): Promise<IcoEntry[]> {
  const source = svg.toString('utf8')
  const glyph = '<g id="tray-glyph"'
  if (!source.includes(glyph)) throw new Error('tray icon: SVG requires a tray-glyph group')
  // Scale around the application tile center, retaining its background and the whale's aspect ratio.
  const tray = Buffer.from(source.replace(glyph, `${glyph} transform="translate(552 544) scale(1.2) translate(-552 -544)"`))
  return Promise.all(sizes.map(async size => ({
    size,
    png: await sharp(tray, { density: SOURCE_DENSITY * size / SOURCE_EDGE }).resize(size, size).png().toBuffer(),
  })))
}

/**
 * Reduce a vector application icon to the glyph a macOS menu bar can tint.
 *
 * A template image is an alpha mask: the system paints every opaque pixel, so the white
 * application tile and the drop shadows must go, and the whale itself has to be opaque rather
 * than filled from a gradient the menu bar would not be able to tint.
 * @param svg - SVG document with a `tray-glyph` group.
 * @returns The same document carrying only the glyph, filled solid.
 */
export function templateGlyphSvg(svg: string): string {
  if (!svg.includes('<g id="tray-glyph"')) throw new Error('tray icon: SVG requires a tray-glyph group')
  return svg
    // The tile and its two gradient overlays are the parts a menu bar must not show.
    .replace(/<rect\b[^>]*\/>/g, '')
    // Shadows bake a grey halo into the mask, which macOS would paint as a solid smudge.
    .replace(/\s+filter="url\(#[^)]*\)"/g, '')
    // A gradient fill survives the removal of its defs only as nothing at all.
    .replace(/fill="url\(#paint\d+_linear_[^)]*\)"/g, 'fill="#000000"')
}

/**
 * Rasterize a template glyph as a square alpha mask of one edge length.
 * @param svg - SVG document already reduced by {@link templateGlyphSvg}.
 * @param size - Bitmap edge to render.
 * @returns PNG bytes; every colour channel is black and only alpha varies.
 */
export async function renderTemplateIcon(svg: string, size: number): Promise<Buffer> {
  // Render large and trim to the glyph first: resizing the whole 1024-unit document down to a
  // menu bar edge would shrink the whale into the padding that surrounds it in the app icon.
  const trimmed = sharp(Buffer.from(svg), { density: 220 }).trim()
  const { data, info } = await trimmed
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  for (let at = 0; at < data.length; at += info.channels) {
    data[at] = 0
    data[at + 1] = 0
    data[at + 2] = 0
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer()
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('tray icon: bitmap is not a PNG stream')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function main(): Promise<void> {
  const entries = await renderTrayIconEntries(await readFile(TRAY_ICON_PATHS.source))
  await writeFile(TRAY_ICON_PATHS.output, packIco(entries))
  console.info(`tray icon: wrote ${TRAY_ICON_PATHS.output} with ${entries.map(entry => String(entry.size)).join(', ')} px bitmaps`)
  const darwinSvg = templateGlyphSvg((await readFile(TRAY_ICON_PATHS.darwinSource)).toString('utf8'))
  await writeFile(TRAY_ICON_PATHS.darwinOutput, await renderTemplateIcon(darwinSvg, DARWIN_TRAY_ICON_EDGES.base))
  await writeFile(TRAY_ICON_PATHS.darwinOutputRetina, await renderTemplateIcon(darwinSvg, DARWIN_TRAY_ICON_EDGES.retina))
  console.info(`tray icon: wrote ${TRAY_ICON_PATHS.darwinOutput} at ${String(DARWIN_TRAY_ICON_EDGES.base)} px`
    + ` and its ${String(DARWIN_TRAY_ICON_EDGES.retina)} px Retina double`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
