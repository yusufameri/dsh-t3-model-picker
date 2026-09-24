/**
 * Encode a recorded screencast into an animated GIF.
 *
 *   node scripts/encode-gif.mjs <run-dir> <out.gif> [--fps 10] [--speed 1.6]
 *                              [--start 0] [--end 15] [--hold 2.5]
 *                              [--width 720] [--colors 128]
 *
 * The run directory must hold `timeline.json` and `frames/` from record.mjs.
 * Cropping, resizing, and GIF assembly use the sharp already present in the
 * DeepSeek Harness checkout; no ffmpeg is involved.
 *
 * Consecutive samples that decode to identical pixels collapse into one GIF
 * frame holding both delays, so the delay list always matches the frame list.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire('/Users/yusufameri/projects/deepseek-harness/package.json')
const sharp = require('sharp')

const [, , runDir, outPath, ...rest] = process.argv
if (runDir === undefined || outPath === undefined) {
  console.error('usage: node scripts/encode-gif.mjs <run-dir> <out.gif> [--fps N] [--speed N] [--start S] [--end S] [--hold S] [--width N] [--colors N]')
  process.exit(1)
}

const option = (name, fallback) => {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? fallback : Number(rest[at + 1])
}

const fps = option('fps', 10)
const speed = option('speed', 1.6)
const hold = option('hold', 2.5)
const width = option('width', 720)
const colors = option('colors', 128)
const stepMs = Math.round(1000 / fps)

const timeline = JSON.parse(readFileSync(join(runDir, 'timeline.json'), 'utf8'))
const { crop } = timeline
const framePath = (index) => join(runDir, 'frames', `${String(index).padStart(4, '0')}.jpg`)

// The screencast can emit a few frames at another viewport size while the
// window settles; keep only the dominant size so the crop is always valid.
const seen = []
for (const frame of timeline.frames) {
  const meta = await sharp(framePath(frame.index)).metadata()
  seen.push({ index: frame.index, timestamp: frame.timestamp, size: `${meta.width}x${meta.height}` })
}
const tally = new Map()
for (const frame of seen) tally.set(frame.size, (tally.get(frame.size) ?? 0) + 1)
const [dominant] = [...tally.entries()].sort((left, right) => right[1] - left[1])[0]
const frames = seen.filter((frame) => frame.size === dominant)
const [frameWidth, frameHeight] = dominant.split('x').map(Number)
if (crop.x + crop.width > frameWidth || crop.y + crop.height > frameHeight) {
  throw new Error(`crop ${JSON.stringify(crop)} does not fit ${dominant}`)
}

const times = frames.map((frame) => frame.timestamp - frames[0].timestamp)
const duration = times.at(-1)
const start = option('start', 0)
const end = option('end', duration)
if (end <= start) throw new Error(`empty interval: ${start}..${end} of ${duration.toFixed(2)}s`)

const step = (1 / fps) * speed
const sampled = []
for (let t = 0; start + t <= end; t += step) {
  const wanted = start + t
  let index = 0
  while (index + 1 < times.length && times[index + 1] <= wanted) index += 1
  sampled.push(frames[index].index)
}

const height = Math.round((crop.height * width) / crop.width)
const cached = new Map()
const cropFrame = async (index) => {
  if (!cached.has(index)) {
    cached.set(index, await sharp(framePath(index))
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
      .resize(width, height)
      .png()
      .toBuffer())
  }
  return cached.get(index)
}

const digest = (buffer) => createHash('md5').update(buffer).digest('hex')
const buffers = []
const delay = []
for (const index of sampled) {
  const buffer = await cropFrame(index)
  if (buffers.length > 0 && digest(buffer) === digest(buffers.at(-1))) {
    delay[delay.length - 1] += stepMs
    continue
  }
  buffers.push(buffer)
  delay.push(stepMs)
}
if (buffers.length < 2) throw new Error(`interval yields ${buffers.length} distinct frames; widen it`)
delay[delay.length - 1] += Math.round(hold * 1000)

const gif = await sharp(buffers, { join: { animated: true } })
  .gif({ loop: 0, delay, colours: colors, effort: 7 })
  .toBuffer()
writeFileSync(outPath, gif)

const meta = await sharp(gif, { animated: true }).metadata()
if (meta.pages !== buffers.length) {
  throw new Error(`encoded ${meta.pages} pages for ${buffers.length} frames`)
}

console.log(JSON.stringify({
  out: outPath,
  source: { dominant, dropped: seen.length - frames.length, duration: Number(duration.toFixed(2)) },
  interval: [Number(start.toFixed(2)), Number(end.toFixed(2))],
  speed,
  fps,
  frames: meta.pages,
  width: meta.width,
  frameHeight: meta.pageHeight,
  playMs: delay.reduce((sum, value) => sum + value, 0),
  bytes: statSync(outPath).size,
}, null, 2))
