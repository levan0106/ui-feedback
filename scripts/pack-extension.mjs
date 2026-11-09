// Đóng gói extension/ thành dist/ui-feedback-bridge-<version>.zip để nộp Chrome Web Store / Edge Add-ons.
// Node thuần: tự ghi zip (deflate), thời gian cố định nên build lặp lại cho ra cùng byte.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extDir = join(root, 'extension')

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  }).sort()
}

export function checkManifest() {
  const m = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'))
  const errs = []
  if (m.manifest_version !== 3) errs.push('manifest_version phải là 3')
  for (const s of [16, 48, 128]) {
    const f = m.icons && m.icons[s]
    if (!f) errs.push(`thiếu icons.${s}`)
    else if (!existsSync(join(extDir, f))) errs.push(`file icon không tồn tại: ${f}`)
  }
  if (!m.description || m.description.length > 132) errs.push('description trống hoặc > 132 ký tự (giới hạn store)')
  if (m.permissions && m.permissions.length) errs.push('extension không được khai báo permissions thừa')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (m.version !== pkg.version) errs.push(`version manifest (${m.version}) khác package.json (${pkg.version})`)
  return { manifest: m, errs }
}

export function buildZip() {
  const files = walk(extDir)
  const parts = []
  const central = []
  let offset = 0
  const dosTime = 0, dosDate = (46 << 9) | (1 << 5) | 1 // 2026-01-01 00:00
  for (const f of files) {
    const name = Buffer.from(relative(extDir, f).split(sep).join('/'))
    const data = readFileSync(f)
    const comp = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // UTF-8 names
    lh.writeUInt16LE(8, 8)
    lh.writeUInt16LE(dosTime, 10)
    lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    parts.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(dosTime, 12)
    ch.writeUInt16LE(dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return { zip: Buffer.concat([...parts, cd, end]), count: files.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { manifest, errs } = checkManifest()
  if (errs.length) {
    console.error('Manifest chưa đạt:\n - ' + errs.join('\n - '))
    process.exit(1)
  }
  const { zip, count } = buildZip()
  const out = join(root, 'dist', `ui-feedback-bridge-${manifest.version}.zip`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, zip)
  console.log(`${relative(root, out)}  (${count} file, ${zip.length} byte)`)
}
