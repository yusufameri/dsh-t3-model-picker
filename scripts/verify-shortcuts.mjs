/**
 * Check the picker's keyboard chords against the real component.
 *
 * Loads `client.js` into a jsdom page, mounts the component React hands the
 * composer, and dispatches real `KeyboardEvent`s at the window. Nothing inside
 * the plugin is mocked. Only the host surfaces it needs are stubbed: the slot
 * registry, the locale, the model directory and the remote catalog. The props
 * come from the seat's own `inject()`, so the component sees what the composer
 * gives it.
 *
 * The plugin itself has no dependencies, so the harness brings its own:
 *
 *   npm install --no-save react react-dom jsdom
 *   node scripts/verify-shortcuts.mjs
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLIENT = new URL('../client.js', import.meta.url)

let failures = 0
let checks = 0

function check(name, ok, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function load(moduleName) {
  try {
    return require(moduleName)
  } catch {
    console.error(`${moduleName} is missing. Run: npm install --no-save react react-dom jsdom`)
    process.exit(2)
  }
}

const { JSDOM } = load('jsdom')

/** A subscribable store in the shape the component's `useSnapshot` expects. */
function createStore(snapshot, extra = {}) {
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    ...extra,
  }
}

const GROUPS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        reasoning: {
          defaultEffort: 'medium',
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
        },
      },
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ],
  },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
]

const CURRENT = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'medium' }

/** Boot a page, load the real client half, and hand back what a check needs. */
async function boot({ platform }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
  // jsdom does no layout, so the two measurements the component asks for come
  // back empty. Stand in for a laid-out node.
  window.Element.prototype.getClientRects = function getClientRects() { return [{ width: 40, height: 28 }] }
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}

  for (const name of [
    'window', 'document', 'navigator', 'location', 'localStorage', 'Node', 'Element',
    'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Event', 'CustomEvent',
    'KeyboardEvent', 'MouseEvent', 'NodeFilter', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'CSS',
  ]) {
    if (window[name] !== undefined) {
      Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const React = load('react')
  const ReactDOM = load('react-dom/client')
  const { act } = React
  const h = React.createElement

  let dictionary = null
  const disposers = []
  const catalog = { ok: true, value: { routableProviders: ['deepseek', 'openai'] } }
  let seat = null
  const ctx = {
    effect(fn) { disposers.push(fn()) },
    on() {},
    locale: { register(_ns, dicts) { dictionary = dicts.en } },
    remote: { $on() {}, session: { modelCatalog: () => Promise.resolve(catalog) } },
    slots: {
      inject(_name, loadSeat) { return loadSeat() },
      register(options, component) {
        seat = { component, props: options.inject('session-1') }
        return () => {}
      },
    },
    modelDirectories: {
      directoryFor: () => {
        const store = createStore(
          { status: 'ready', groups: GROUPS, current: CURRENT, failures: [] },
          { load: () => Promise.resolve(), select: () => Promise.resolve({ ok: true }) },
        )
        return { store, load: store.load, select: store.select }
      },
    },
    sessions: { subagentAddress: () => undefined },
  }

  const loaded = []
  window.__ModuleLoader__ = { load: (definition) => { loaded.push(definition) } }
  new Function(readFileSync(CLIENT, 'utf8'))()

  const definition = loaded.find(entry => entry.id === 'dsh-t3-model-picker')
  if (definition === undefined) throw new Error('client.js did not register its module')
  definition.factory(name => require(name)).apply(ctx)

  const t = (key, params) => String(dictionary[key] ?? key).replace(
    /\{(\w+)\}/gu,
    (_, name) => String(params?.[name] ?? ''),
  )

  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = ReactDOM.createRoot(container)

  const render = async (count, overrides = {}) => {
    await act(async () => {
      root.render(h(
        'div',
        null,
        ...Array.from({ length: count }, (_, index) => h(
          seat.component,
          { ...seat.props, t, key: `seat-${index}`, ...overrides },
        )),
      ))
    })
  }

  /** Dispatch a real keydown, flushed through React, and hand back the event. */
  const press = async (init, from) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    await act(async () => { (from ?? window).dispatchEvent(event) })
    return event
  }

  const click = async (node) => { await act(async () => { node.click() }) }

  return {
    window, act, render, press, click, t,
    panels: () => window.document.querySelectorAll('.t3mp-panel').length,
    triggers: () => window.document.querySelectorAll('.t3mp-trigger'),
    expanded: () => window.document.querySelectorAll('.t3mp-trigger[aria-expanded="true"]').length,
    search: () => window.document.querySelector('.t3mp-search input'),
    unmount: async () => { await act(async () => { root.unmount() }) },
    dispose: () => {
      for (const dispose of disposers.reverse()) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

const MAC = { metaKey: true, code: 'KeyM', key: 'm' }
const OTHER = { ctrlKey: true, code: 'KeyM', key: 'm' }

async function main() {
  console.log('\nmacOS, Cmd:')
  const mac = await boot({ platform: 'MacIntel' })
  await mac.render(1)

  check('the card starts closed', mac.panels() === 0)

  const opened = await mac.press(MAC)
  check('Cmd+M opens the card', mac.panels() === 1, `panels=${mac.panels()}`)
  check('Cmd+M is consumed, not passed on to the host', opened.defaultPrevented)
  check('the search field takes focus on open', mac.search() !== null
    && mac.window.document.activeElement === mac.search())

  // The same chord typed into the composer editor, not into the card.
  const editor = mac.window.document.createElement('textarea')
  mac.window.document.body.appendChild(editor)
  editor.focus()
  await mac.press(MAC, editor)
  check('Cmd+M closes the card again', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.press({ code: 'KeyM', key: 'm' })
  check('a bare M does nothing', mac.panels() === 0)

  await mac.press({ ...MAC, shiftKey: true })
  check('Cmd+Shift+M does nothing', mac.panels() === 0)

  await mac.press({ ...MAC, altKey: true })
  check('Cmd+Alt+M does nothing', mac.panels() === 0)

  await mac.press({ ...MAC, repeat: true })
  check('a held Cmd+M does not flicker the card open', mac.panels() === 0)

  await mac.press(OTHER)
  check('Ctrl+M does nothing on macOS', mac.panels() === 0)

  await mac.press({ metaKey: true, code: 'KeyN', key: 'n' })
  check('Cmd+N does nothing', mac.panels() === 0)

  // The trigger click path, which shares `toggle` with the chord.
  await mac.click(mac.triggers()[0])
  check('clicking the trigger opens the card', mac.panels() === 1, `panels=${mac.panels()}`)
  await mac.click(mac.triggers()[0])
  check('clicking the trigger again closes it', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.press(MAC)
  const effortRow = mac.window.document.querySelector('.t3mp-effort-row')
  check('the effort footer is reachable while open', effortRow !== null)
  await mac.click(effortRow)
  check('the effort pane opens', mac.window.document.querySelector('.t3mp-pane-head') !== null)
  await mac.press(MAC)
  check('Cmd+M closes the card from the effort pane too', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.press(MAC)
  await mac.press({ key: 'Escape' }, mac.search())
  check('Escape still closes the card', mac.panels() === 0, `panels=${mac.panels()}`)

  // Two seats mounted, as two live sessions would: one keystroke, one card.
  await mac.render(2)
  await mac.press(MAC)
  check('two mounted seats open exactly one card', mac.panels() === 1, `panels=${mac.panels()}`)
  check('exactly one seat reports itself open', mac.expanded() === 1, `expanded=${mac.expanded()}`)
  await mac.press(MAC)
  check('the chord closes it again', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.render(1, { locked: true })
  await mac.press(MAC)
  check('a locked seat ignores the chord', mac.panels() === 0, `panels=${mac.panels()}`)
  check('a locked seat shows a disabled trigger', mac.triggers()[0]?.disabled === true)

  await mac.render(1, { available: false })
  await mac.press(MAC)
  check('an unavailable seat ignores the chord', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.render(1)
  check('the trigger tooltip advertises ⌘M on macOS', mac.triggers()[0].title.endsWith('⌘M'), mac.triggers()[0].title)

  await mac.unmount()
  await mac.press(MAC)
  check('an unmounted seat releases the chord', mac.panels() === 0, `panels=${mac.panels()}`)
  mac.dispose()

  console.log('\nWindows and Linux, Ctrl:')
  const pc = await boot({ platform: 'Win32' })
  await pc.render(1)
  check('the tooltip advertises Ctrl+M off macOS', pc.triggers()[0].title.endsWith('Ctrl+M'), pc.triggers()[0].title)
  await pc.press(MAC)
  check('Cmd+M does nothing off macOS', pc.panels() === 0, `panels=${pc.panels()}`)
  await pc.press(OTHER)
  check('Ctrl+M opens the card', pc.panels() === 1, `panels=${pc.panels()}`)
  await pc.press(OTHER)
  check('Ctrl+M closes the card', pc.panels() === 0, `panels=${pc.panels()}`)

  // A layout where M is not the letter m, such as Dvorak or a non-Latin one.
  await pc.press({ ctrlKey: true, code: 'KeyM', key: 'ь' })
  check('the chord follows the physical key, not the layout', pc.panels() === 1, `panels=${pc.panels()}`)

  await pc.unmount()
  pc.dispose()

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
