/**
 * Minimal CDP driver for the running DSH desktop page.
 *
 *   node cdp.mjs eval "<expression>"
 *   node cdp.mjs click "<selector>"
 *   node cdp.mjs shot <output.png>
 *   node cdp.mjs key "<Key>" [meta|ctrl] [shift]
 *
 * Reads the page target from http://127.0.0.1:9222/json/list.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [, , command, ...args] = process.argv

async function target() {
  const response = await fetch('http://127.0.0.1:9222/json/list')
  const targets = await response.json()
  const page = targets.find(candidate => candidate.type === 'page')
  if (page === undefined) throw new Error('no page target')
  return page.webSocketDebuggerUrl
}

async function connect() {
  const socket = new WebSocket(await target())
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { socket, send }
}

const { socket, send } = await connect()
await send('Runtime.enable')
await send('Page.enable')

try {
  if (command === 'eval' || command === 'run') {
    const expression = command === 'run'
      ? readFileSync(args[0], 'utf8')
      : args.join(' ')
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      console.error('EXCEPTION:', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
      process.exitCode = 1
    } else {
      console.log(typeof result.result.value === 'string'
        ? result.result.value
        : JSON.stringify(result.result.value, null, 2))
    }
  } else if (command === 'click') {
    const selector = args.join(' ')
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return 'NOT FOUND';
        node.scrollIntoView({ block: 'center' });
        const rect = node.getBoundingClientRect();
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          node.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          }));
        }
        return 'CLICKED ' + rect.left.toFixed(0) + ',' + rect.top.toFixed(0);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    console.log(result.result.value)
  } else if (command === 'watch') {
    const seconds = Number(args[0] ?? 12)
    const reload = args.includes('--reload')
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? []).map(argument => argument.value ?? argument.description ?? '').join(' ')
        console.log(`[${message.params.type}]`, text.slice(0, 600))
      } else if (message.method === 'Runtime.exceptionThrown') {
        console.log('[exception]', String(message.params.exceptionDetails.exception?.description ?? '').slice(0, 900))
      } else if (message.method === 'Log.entryAdded') {
        console.log(`[log:${message.params.entry.level}]`, String(message.params.entry.text).slice(0, 600))
      }
    })
    await send('Log.enable')
    if (reload) await send('Page.reload', { ignoreCache: true })
    await new Promise(resolve => setTimeout(resolve, seconds * 1000))
  } else if (command === 'reload') {
    await send('Page.reload', { ignoreCache: true })
    console.log('reloaded')
  } else if (command === 'shot') {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(args[0], Buffer.from(result.data, 'base64'))
    console.log('wrote', args[0])
  } else if (command === 'key') {
    const key = args[0]
    const modifiers = args.slice(1)
    const bits = (modifiers.includes('alt') ? 1 : 0) | (modifiers.includes('ctrl') ? 2 : 0)
      | (modifiers.includes('meta') ? 4 : 0) | (modifiers.includes('shift') ? 8 : 0)
    const codes = {
      Escape: { code: 'Escape', keyCode: 27, text: '' },
      Enter: { code: 'Enter', keyCode: 13, text: '\r' },
      ArrowDown: { code: 'ArrowDown', keyCode: 40, text: '' },
      ArrowUp: { code: 'ArrowUp', keyCode: 38, text: '' },
      ArrowRight: { code: 'ArrowRight', keyCode: 39, text: '' },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37, text: '' },
      Tab: { code: 'Tab', keyCode: 9, text: '' },
    }
    const digit = /^[1-9]$/u.test(key)
    const descriptor = codes[key] ?? (digit ? { code: `Digit${key}`, keyCode: 48 + Number(key), text: key } : { code: key, keyCode: 0, text: key })
    const base = {
      modifiers: bits,
      key: digit ? key : key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
    }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '' })
    if (descriptor.text !== '' && modifiers === 0) {
      await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: descriptor.text })
    }
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    console.log('key', key, modifiers.join('+'))
  } else if (command === 'type') {
    for (const character of args.join(' ')) {
      await send('Input.dispatchKeyEvent', { type: 'char', text: character })
    }
    console.log('typed')
  } else {
    console.error('unknown command', command)
    process.exitCode = 1
  }
} finally {
  socket.close()
}
