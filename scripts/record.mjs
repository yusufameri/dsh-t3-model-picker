/**
 * Record the picker demo from the running DSH desktop page over CDP.
 *
 *   node scripts/record.mjs <run-dir>
 *
 * Writes screencast frames plus a timeline to <run-dir>/frames, three cropped
 * stills to <run-dir>/stills, and prints the computed crop rectangle.
 *
 * The page must already show a scratch session whose composer carries the
 * plugin's trigger; the script never touches another session's model.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const runDir = process.argv[2]
if (runDir === undefined) {
  console.error('usage: node scripts/record.mjs <run-dir>')
  process.exit(1)
}

const framesDir = join(runDir, 'frames')
const stillsDir = join(runDir, 'stills')
mkdirSync(framesDir, { recursive: true })
mkdirSync(stillsDir, { recursive: true })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function target() {
  const response = await fetch('http://127.0.0.1:9222/json/list')
  const targets = await response.json()
  const page = targets.find((candidate) => candidate.type === 'page')
  if (page === undefined) throw new Error('no page target')
  return page.webSocketDebuggerUrl
}

const socket = new WebSocket(await target())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
const frames = []

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.method === 'Page.screencastFrame') {
    frames.push({
      index: frames.length,
      timestamp: message.params.metadata.timestamp,
      data: message.params.data,
    })
    void send('Page.screencastFrameAck', { sessionId: message.params.sessionId })
    return
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

function send(method, params = {}) {
  nextId += 1
  const id = nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return result.result.value
}

const rect = (selector) => evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
})()`)

async function moveTo(x, y, steps = 12) {
  const from = await evaluate(`(${JSON.stringify({ x, y })}, window.__t3mpLast ?? { x, y })`)
  for (let step = 1; step <= steps; step += 1) {
    const px = from.x + ((x - from.x) * step) / steps
    const py = from.y + ((y - from.y) * step) / steps
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 0 })
    await wait(12)
  }
  await evaluate(`window.__t3mpLast = { x: ${x}, y: ${y} }`)
}

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await wait(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await wait(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

async function clickSelector(selector, settle = 400) {
  const box = await rect(selector)
  if (box === null) throw new Error(`missing element: ${selector}`)
  await moveTo(box.cx, box.cy)
  await wait(120)
  await click(box.cx, box.cy)
  await wait(settle)
  return box
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', text: character, unmodifiedText: character, key: character,
    })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
    await wait(70)
  }
}

async function backspace(times) {
  for (let index = 0; index < times; index += 1) {
    const base = {
      key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await wait(60)
  }
}

async function pressKey(key, code, keyCode, modifiers = 0) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await wait(60)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function state(label) {
  const value = await evaluate(`JSON.stringify({
    panel: !!document.querySelector('.t3mp-panel'),
    rail: [...document.querySelectorAll('.t3mp-rail-button')].map((b) => b.dataset.t3mpRail),
    query: document.querySelector('.t3mp-search-input')?.value ?? null,
    rows: document.querySelectorAll('.t3mp-row').length,
    focus: document.activeElement?.className ?? null,
  })`)
  console.log(label, value)
  return JSON.parse(value)
}

async function captureStill(name, clip) {
  const result = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
    clip: { ...clip, scale: 2 },
  })
  writeFileSync(join(stillsDir, name), Buffer.from(result.data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')

const ready = await evaluate(`!!document.querySelector('.t3mp-trigger')`)
if (!ready) throw new Error('the picker trigger is not on the page')

// Close anything left open and park the pointer on the trigger.
await evaluate(`(() => {
  if (document.querySelector('.t3mp-panel')) document.querySelector('.t3mp-trigger').click();
  window.__t3mpLast = { x: 0, y: 0 };
  return true;
})()`)
await wait(400)

const trigger = await rect('.t3mp-trigger')
await send('Page.startScreencast', {
  format: 'jpeg', quality: 85, maxWidth: 1728, maxHeight: 1080, everyNthFrame: 1,
})

// 1. Approach the trigger.
await moveTo(trigger.cx, trigger.cy, 16)
await wait(700)

// 2. Open the picker.
await click(trigger.cx, trigger.cy)
await wait(900)
await state('after-open')

const panel = await rect('.t3mp-panel')
if (panel === null) throw new Error('the panel did not open')
const viewport = await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`)
// Tight crop: the picker card and the trigger under it, nothing else. Keeps
// unrelated conversation content out of a public demo.
const PAD = 8
const left = Math.max(0, Math.round(panel.x - PAD))
const top = Math.max(0, Math.round(panel.y - PAD))
const crop = {
  x: left,
  y: top,
  width: Math.min(Math.round(panel.width + PAD * 2), viewport.w - left),
  height: Math.min(Math.round(trigger.y + trigger.height + PAD - top), viewport.h - top),
}

await captureStill('01-picker-open.png', crop)
await state('after-still-1')

// 3. Search, showing provider-grouped results.
await clickSelector('.t3mp-search-input', 300)
await state('after-focus-search')
await typeText('opus')
await state('after-type')
await wait(900)
await captureStill('02-search-grouped.png', crop)

// 4. Clear the query; the rail comes back.
await backspace(4)
await state('after-backspace')
await wait(700)

// 5. Switch to the provider list from the rail.
await clickSelector('[data-t3mp-rail="command-code"]', 700)

// 6. Favorite the first row that is not already a favorite; it bubbles up.
const stars = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.t3mp-row')]
    .find((candidate) => candidate.querySelector('.t3mp-star:not(.t3mp-star-on)'));
  const star = row?.querySelector('.t3mp-star');
  if (!star) return null;
  const r = star.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, name: row.querySelector('.t3mp-row-name')?.textContent };
})()`)
if (stars === null) throw new Error('no unfavorited star to click')
await moveTo(stars.x, stars.y)
await wait(250)
await click(stars.x, stars.y)
await wait(900)

// 7. Show the Favorites pane with the new entry.
await clickSelector('[data-t3mp-rail="favorites"]', 900)
await captureStill('03-favorites.png', crop)

// 8. Jump to the first favorite with the chord.
await pressKey('1', 'Digit1', 49, 4)
await wait(1500)

await send('Page.stopScreencast')
await wait(400)

// Put the browser's favorites back the way the recording found them.
await evaluate(`(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const trigger = document.querySelector('.t3mp-trigger');
  if (!document.querySelector('.t3mp-panel')) trigger.click();
  await wait(400);
  document.querySelectorAll('.t3mp-rail-button')[1]?.click();
  await wait(400);
  const row = [...document.querySelectorAll('.t3mp-row')].find(
    (candidate) => candidate.querySelector('.t3mp-row-name')?.textContent === ${JSON.stringify(stars.name)});
  row?.querySelector('.t3mp-star')?.click();
  await wait(300);
  if (document.querySelector('.t3mp-panel')) trigger.click();
  return 'restored';
})()`)
await wait(500)

const timeline = frames.map((frame) => ({
  index: frame.index,
  timestamp: frame.timestamp,
  bytes: Buffer.from(frame.data, 'base64').length,
}))

for (const frame of frames) {
  writeFileSync(join(framesDir, `${String(frame.index).padStart(4, '0')}.jpg`), Buffer.from(frame.data, 'base64'))
}
writeFileSync(join(runDir, 'timeline.json'), JSON.stringify({ crop, frames: timeline }, null, 2))
writeFileSync(join(runDir, 'starred.txt'), stars.name ?? '')

console.log(JSON.stringify({ crop, frameCount: frames.length, starred: stars.name }, null, 2))
socket.close()
