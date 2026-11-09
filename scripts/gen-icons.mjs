// Sinh extension/icons/icon{16,32,48,128}.png bằng Node thuần (zlib), không dependency.
// Hình: nền bo góc xanh, vòng ngắm trắng (chỉ vào phần tử) + chấm giữa.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'extension', 'icons')

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// Trả về độ phủ 0..1 của hình tại điểm (x,y) trong hệ toạ độ 0..1.
function shape(x, y) {
  const bg = [0x25, 0x63, 0xeb]
  const white = [255, 255, 255]
  // bo góc
  const r = 0.22
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0)
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0)
  if (Math.hypot(dx, dy) > r) return null
  const d = Math.hypot(x - 0.5, y - 0.5)
  const ring = d > 0.27 && d < 0.35
  const dot = d < 0.1
  const tick =
    (Math.abs(x - 0.5) < 0.04 && (Math.abs(y - 0.5) > 0.2 && Math.abs(y - 0.5) < 0.4)) ||
    (Math.abs(y - 0.5) < 0.04 && (Math.abs(x - 0.5) > 0.2 && Math.abs(x - 0.5) < 0.4))
  return ring || dot || tick ? white : bg
}

function render(size) {
  const SS = 4
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shape((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++ }
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4
      const n = SS * SS
      raw[o] = a ? Math.round(r / a) : 0
      raw[o + 1] = a ? Math.round(g / a) : 0
      raw[o + 2] = a ? Math.round(b / a) : 0
      raw[o + 3] = Math.round((a / n) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(outDir, { recursive: true })
for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${s}.png`), render(s))
  console.log(`extension/icons/icon${s}.png`)
}
