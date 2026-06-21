// Generates askd's PNG icons (no external deps). Rounded indigo square with a
// lighter inset panel — evokes a side panel. Run: `node icons/gen-icons.mjs`
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function crc32(buf) {
  let c = ~0 >>> 0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function makePng(size) {
  const W = size
  const H = size
  const r = Math.round(size * 0.22) // corner radius
  const inset = Math.round(size * 0.3)

  const inside = (x, y) => {
    let dx = 0
    let dy = 0
    if (x < r) dx = r - x
    else if (x >= W - r) dx = x - (W - 1 - r)
    if (y < r) dy = r - y
    else if (y >= H - r) dy = y - (H - 1 - r)
    return dx * dx + dy * dy <= r * r
  }

  const raw = Buffer.alloc((W * 4 + 1) * H)
  let o = 0
  for (let y = 0; y < H; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < W; x++) {
      if (!inside(x, y)) {
        raw[o++] = 0
        raw[o++] = 0
        raw[o++] = 0
        raw[o++] = 0
      } else if (x >= inset && x < W - inset && y >= inset && y < H - inset) {
        raw[o++] = 0xc7
        raw[o++] = 0xd2
        raw[o++] = 0xfe
        raw[o++] = 255
      } else {
        raw[o++] = 0x4f
        raw[o++] = 0x46
        raw[o++] = 0xe5
        raw[o++] = 255
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(here, `icon${s}.png`), makePng(s))
}
console.log('icons generated: 16, 32, 48, 128')
