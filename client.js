/**
 * Client half of the T3 model picker.
 *
 * A port of the model selector from T3 Code
 * (https://github.com/pingdotgg/t3code), by the T3 Code authors under MIT.
 * The shape, the search ranking, the favorites model, and the jump chords are
 * theirs; only the data underneath is DeepSeek Harness's.
 *
 * Registers a second occupant of the composer's `conversation.input.model`
 * seat at priority -1, so it shadows the shipped ModelSelect (same cell,
 * different priority = shadowing) while reading the SAME per-session model
 * directory (`ctx.modelDirectories`) that seat and the `/model` popup use.
 * A switch made here is what those surfaces show next.
 *
 * Shape and behavior follow T3 Code's ProviderModelPicker: a 44px provider
 * rail on the left (Favorites first), a borderless search field at the top of
 * the results column, model rows that carry a provider footer line, a star
 * toggle per row, and Cmd/Ctrl+1..9 jump shortcuts for the first nine rows of
 * the visible list. Three deliberate departures:
 *   - search results are grouped under provider headings, where T3 renders one
 *     flat ranked list;
 *   - a footer row keeps the reasoning-effort selector reachable, since the
 *     shadowed seat was the only surface that exposed it in the composer;
 *   - the row of the model in use carries a check mark, because this seat is
 *     single-select and the trigger is not always in view.
 */

window.__ModuleLoader__.load({
  id: 'dsh-t3-model-picker',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    const h = React.createElement
    const {
      useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 't3ModelPicker'

    /** Favorites persistence key; the value is a JSON array of `{ provider, model }`. */
    const FAVORITES_KEY = 'dsh.t3-model-picker.favorites.v1'

    /** Number of models reachable through the jump chord (Cmd/Ctrl+1..9). */
    const JUMP_COUNT = 9

    /** Score subtracted from a favorite so favorites win near-ties (T3's boost). */
    const FAVORITE_SCORE_BOOST = 24

    const EN = {
      'trigger.fallback': 'Select model',
      'trigger.loading': 'Loading models…',
      'trigger.aria': 'Select model, current {model}',
      'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
      'badge.unavailable': 'Unavailable',
      'search.placeholder': 'Search models...',
      'panel.aria': 'Model picker',
      'rail.aria': 'Providers',
      'rail.favorites': 'Favorites',
      'favorite.add': 'Add to favorites',
      'favorite.remove': 'Remove from favorites',
      'empty.models': 'No models found',
      'status.loading': 'Loading models…',
      'error.load': 'Catalog failed to load: {message}',
      'error.action': 'Model selection failed: {message}',
      'error.sessionInUse': 'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
      'action.retry': 'Retry',
      'effort.row': 'Effort',
      'effort.title': 'Reasoning effort',
      'effort.providerDefault': 'Default',
      'effort.back': 'Back to models',
      'warning.groupLoad': '{name} failed to load: {message}',
      'group.models': '{count} models',
      'shortcut.aria': 'Shortcut {label}',
    }

    const ZH = {
      'trigger.fallback': '选择模型',
      'trigger.loading': '正在加载模型…',
      'trigger.aria': '选择模型，当前 {model}',
      'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
      'badge.unavailable': '不可用',
      'search.placeholder': '搜索模型...',
      'panel.aria': '模型选择器',
      'rail.aria': '提供方',
      'rail.favorites': '收藏',
      'favorite.add': '添加收藏',
      'favorite.remove': '取消收藏',
      'empty.models': '没有匹配的模型',
      'status.loading': '正在加载模型…',
      'error.load': '模型目录加载失败：{message}',
      'error.action': '模型切换失败：{message}',
      'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
      'action.retry': '重试',
      'effort.row': '推理等级',
      'effort.title': '推理等级',
      'effort.providerDefault': '默认',
      'effort.back': '返回模型列表',
      'warning.groupLoad': '{name} 加载失败：{message}',
      'group.models': '{count} 个模型',
      'shortcut.aria': '快捷键 {label}',
    }

    // ---------------------------------------------------------------- search

    /** Lowercase and trim; the scoring tiers expect pre-normalized inputs. */
    function normalize(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : ''
    }

    /** Subsequence score with first-index, gap, span, and length penalties. */
    function scoreSubsequence(value, query) {
      if (query === '') return 0
      let queryIndex = 0
      let firstMatchIndex = -1
      let previousMatchIndex = -1
      let gapPenalty = 0
      for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
        if (value[valueIndex] !== query[queryIndex]) continue
        if (firstMatchIndex === -1) firstMatchIndex = valueIndex
        if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1
        previousMatchIndex = valueIndex
        queryIndex += 1
        if (queryIndex === query.length) {
          const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length
          return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty(value, query)
        }
      }
      return null
    }

    function lengthPenalty(value, query) {
      return Math.min(64, Math.max(0, value.length - query.length))
    }

    function boundaryIndex(value, query, markers) {
      let best = null
      for (const marker of markers) {
        const at = value.indexOf(marker + query)
        if (at === -1) continue
        const index = at + marker.length
        if (best === null || index < best) best = index
      }
      return best
    }

    function scoreQueryMatch(input) {
      const { value, query } = input
      if (value === '' || query === '') return null
      if (value === query) return input.exactBase
      if (value.startsWith(query)) return input.prefixBase + lengthPenalty(value, query)
      const boundary = boundaryIndex(value, query, [' ', '-', '_', '/'])
      if (boundary !== null) return input.boundaryBase + boundary * 2 + lengthPenalty(value, query)
      const includes = value.indexOf(query)
      if (includes !== -1) return input.includesBase + includes * 2 + lengthPenalty(value, query)
      if (input.fuzzyBase !== undefined && query.length >= 3) {
        const fuzzy = scoreSubsequence(value, query)
        if (fuzzy !== null) return input.fuzzyBase + fuzzy
      }
      return null
    }

    /** Concatenated searchable text; also the deterministic tie-breaker. */
    function searchText(row) {
      return normalize([
        row.model.name, row.model.description, row.provider, row.providerName,
      ].filter(value => typeof value === 'string' && value.length > 0).join(' '))
    }

    /** Tiered tokenized score over the row's searchable fields; null means no match. */
    function scoreRow(row, query) {
      const tokens = normalize(query).split(/\s+/).filter(token => token.length > 0)
      if (tokens.length === 0) return 0
      const name = normalize(row.model.name)
      const description = normalize(row.model.description)
      const provider = normalize(row.provider)
      const providerName = normalize(row.providerName)
      const combined = searchText(row)
      const fields = description === ''
        ? [name, provider, providerName, combined]
        : [name, description, provider, providerName, combined]
      let score = 0
      for (const token of tokens) {
        let best = null
        for (let index = 0; index < fields.length; index += 1) {
          const value = fields[index]
          if (value === '') continue
          const fieldScore = scoreQueryMatch({
            value,
            query: token,
            exactBase: index * 10,
            prefixBase: index * 10 + 2,
            boundaryBase: index * 10 + 4,
            includesBase: index * 10 + 6,
            ...(token.length >= 3 ? { fuzzyBase: index * 10 + 100 } : {}),
          })
          if (fieldScore !== null && (best === null || fieldScore < best)) best = fieldScore
        }
        if (best === null) return null
        score += best
      }
      return row.favorite ? score - FAVORITE_SCORE_BOOST : score
    }

    // ------------------------------------------------------------- shortcuts

    /** Whether this platform renders the Command glyph. */
    function isCommandPlatform() {
      const platform = typeof navigator === 'undefined' ? '' : String(navigator.platform ?? '')
      return /mac|iphone|ipad|ipod/i.test(platform)
    }

    /** The Cmd/Ctrl+N label for the Nth (0-based) jump slot. */
    function jumpLabel(index) {
      return `${isCommandPlatform() ? '⌘' : 'Ctrl+'}${index + 1}`
    }

    /** The jump index for a keydown event, or null. */
    function jumpIndexFromEvent(event) {
      const primary = isCommandPlatform() ? event.metaKey : event.ctrlKey
      if (!primary || event.shiftKey || event.altKey) return null
      if (!/^[1-9]$/u.test(event.key)) return null
      return Number(event.key) - 1
    }

    // ------------------------------------------------------------- favorites

    function readFavorites() {
      try {
        const raw = window.localStorage.getItem(FAVORITES_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter(entry => entry !== null && typeof entry === 'object'
            && typeof entry.provider === 'string' && typeof entry.model === 'string')
          .map(entry => ({ provider: entry.provider, model: entry.model }))
      } catch (error) {
        console.warn('[t3-model-picker] favorites were not readable:', error)
        return []
      }
    }

    /** Favorites as one subscribable value, persisted to localStorage per toggle. */
    function createFavoritesStore() {
      let value = readFavorites()
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /**
         * Add or remove one `provider/model` entry.
         * @param provider - the provider id.
         * @param model - the provider-owned model id.
         */
        toggle(provider, model) {
          const present = value.some(entry => entry.provider === provider && entry.model === model)
          value = present
            ? value.filter(entry => !(entry.provider === provider && entry.model === model))
            : [...value, { provider, model }]
          try {
            window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(value))
          } catch (error) {
            console.warn('[t3-model-picker] favorites were not persisted:', error)
          }
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // ---------------------------------------------------------- availability

    /**
     * The Host catalog's routable provider list, which is what marks a
     * provider "Unavailable" in the picker. The shared model directory does
     * not carry it, so this reads the same `session/modelCatalog` RPC once
     * per Host generation and refreshes on the events that can change it.
     *
     * @param remote - the client remote service.
     * @returns a snapshot store of `{ status, providers }`.
     */
    function createRoutableStore(remote) {
      let value = { status: 'idle', providers: [] }
      const listeners = new Set()
      let inflight
      const publish = (next) => {
        value = next
        for (const listener of [...listeners]) listener()
      }
      const load = () => {
        if (inflight !== undefined) return inflight
        publish({ status: 'loading', providers: value.providers })
        inflight = Promise.resolve()
          .then(() => remote.session.modelCatalog())
          .then((response) => {
            if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
            publish({ status: 'ready', providers: [...response.value.routableProviders] })
          })
          .catch((error) => {
            console.warn('[t3-model-picker] provider availability unavailable:', error)
            publish({ status: 'error', providers: [] })
          })
          .finally(() => { inflight = undefined })
        return inflight
      }
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        load,
      }
    }

    // ------------------------------------------------------------------ icons

    function icon(children, props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        ...props,
      }, children)
    }

    function SearchIcon(props) {
      return icon([h('circle', { cx: 11, cy: 11, r: 8, key: 'c' }), h('path', { d: 'm21 21-4.3-4.3', key: 'p' })], props)
    }

    function ChevronDownIcon(props) {
      return icon(h('path', { d: 'm6 9 6 6 6-6' }), props)
    }

    function ChevronRightIcon(props) {
      return icon(h('path', { d: 'm9 18 6-6-6-6' }), props)
    }

    function CheckIcon(props) {
      return icon(h('path', { d: 'M20 6 9 17l-5-5' }), props)
    }

    function StarIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: props.filled === true ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        className: props.className,
      }, h('polygon', {
        points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2',
      }))
    }

    /**
     * T3's provider glyph fallback: up to two initials of the display name,
     * tinted by a per-provider accent derived from the provider id.
     * @param name - the provider display name.
     * @returns the initials.
     */
    function initialsOf(name) {
      const words = String(name ?? '').replace(/[_-]+/gu, ' ').split(/\s+/u).filter(Boolean)
      if (words.length === 0) return '?'
      if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase()
      return words.slice(0, 2).map(word => Array.from(word)[0] ?? '').join('').toUpperCase()
    }

    /** A slug-shaped provider name (`command-code`, `opencode_go`) as words. */
    function displayProviderName(name) {
      const value = String(name ?? '')
      if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u.test(value) || !/[_-]/u.test(value)) return value
      return value
        .split(/[_-]+/u)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    }

    const ACCENTS = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#7f9cf5']

    /** A stable accent color for one provider id. */
    function accentOf(providerId) {
      let hash = 0
      for (let index = 0; index < providerId.length; index += 1) {
        hash = (hash * 31 + providerId.charCodeAt(index)) >>> 0
      }
      return ACCENTS[hash % ACCENTS.length]
    }

    function ProviderGlyph(props) {
      const { providerId, name, className } = props
      return h('span', {
        className,
        'data-t3mp-glyph': providerId,
        style: { '--t3mp-accent': accentOf(providerId) },
      }, initialsOf(name))
    }

    // ------------------------------------------------------------------ store

    /** Subscribe a component to one snapshot store. */
    function useSnapshot(store) {
      const subscribe = useCallback(listener => store.subscribe(listener), [store])
      const getSnapshot = useCallback(() => store.getSnapshot(), [store])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    // ------------------------------------------------------------------- view

    const PANEL_WIDTH = 360
    const PANEL_MAX_HEIGHT = 346
    const PANEL_MARGIN = 12

    /**
     * The composer's model seat: trigger plus, while open, the T3-shaped card.
     * @param props - owner share (`locked`), the injected face, and the `t` seat.
     * @returns the seated control.
     */
    function ModelPicker({
      locked, available, directory, load, select, favorites, routable, t,
    }) {
      const state = useSnapshot(directory)
      const catalog = useSnapshot(routable)
      const favoriteList = useSnapshot(favorites)

      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('favorites')
      const [query, setQuery] = useState('')
      const [highlight, setHighlight] = useState(0)
      const [menuPos, setMenuPos] = useState(null)
      const [toast, setToast] = useState(null)

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const panelRef = useRef(null)
      const searchRef = useRef(null)
      const railRef = useRef(null)
      const rowRefs = useRef([])
      const toastSeq = useRef(0)
      const lastActionRef = useRef('load')

      const groups = state.groups
      const current = state.current
      const favoriteKeys = useMemo(
        () => new Set(favoriteList.map(entry => `${entry.provider}\u0000${entry.model}`)),
        [favoriteList],
      )
      const routableKnown = catalog.status === 'ready'
      const routableSet = useMemo(() => new Set(catalog.providers), [catalog.providers])

      /** Every advertised model with the provider facts the rows render. */
      const allRows = useMemo(() => {
        const rows = []
        groups.forEach((group, groupIndex) => {
          group.models.forEach((model, modelIndex) => {
            const key = `${group.id}\u0000${model.id}`
            rows.push({
              key,
              provider: group.id,
              providerName: displayProviderName(group.name),
              model,
              groupIndex,
              modelIndex,
              favorite: favoriteKeys.has(key),
              unavailable: routableKnown && !routableSet.has(group.id),
            })
          })
        })
        return rows
      }, [groups, favoriteKeys, routableKnown, routableSet])

      const rowByKey = useMemo(() => new Map(allRows.map(row => [row.key, row])), [allRows])
      const currentRow = current === null
        ? undefined
        : rowByKey.get(`${current.provider}\u0000${current.model}`)
      const reasoning = currentRow?.model.reasoning
      const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = reasoning === undefined
        ? undefined
        : effectiveEffort === undefined
          ? t('effort.providerDefault')
          : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort

      /** The provider list the rail renders, in catalog order. */
      const providers = useMemo(
        () => groups.map(group => ({ id: group.id, name: displayProviderName(group.name) })),
        [groups],
      )

      const searching = normalize(query).length > 0

      /** The rows the results column shows, plus whether they carry provider headings. */
      const listed = useMemo(() => {
        if (searching) {
          const scored = []
          for (const row of allRows) {
            const score = scoreRow(row, query)
            if (score !== null) scored.push({ row, score })
          }
          scored.sort((left, right) => {
            if (left.score !== right.score) return left.score - right.score
            const leftFavorite = left.row.favorite ? 0 : 1
            const rightFavorite = right.row.favorite ? 0 : 1
            if (leftFavorite !== rightFavorite) return leftFavorite - rightFavorite
            if (left.row.groupIndex !== right.row.groupIndex) return left.row.groupIndex - right.row.groupIndex
            if (left.row.modelIndex !== right.row.modelIndex) return left.row.modelIndex - right.row.modelIndex
            return searchText(left.row).localeCompare(searchText(right.row))
          })
          const sections = []
          const byProvider = new Map()
          for (const { row } of scored) {
            let section = byProvider.get(row.provider)
            if (section === undefined) {
              section = { id: row.provider, name: row.providerName, rows: [], unavailable: row.unavailable }
              byProvider.set(row.provider, section)
              sections.push(section)
            }
            section.rows.push(row)
          }
          return { grouped: true, sections, rows: scored.map(entry => entry.row) }
        }
        if (pane === 'favorites') {
          const rows = allRows
            .filter(row => row.favorite)
            .sort((left, right) => (left.groupIndex - right.groupIndex) || (left.modelIndex - right.modelIndex))
          return { grouped: false, sections: [], rows }
        }
        const rows = allRows
          .filter(row => row.provider === pane)
          .sort((left, right) => (Number(right.favorite) - Number(left.favorite)) || (left.modelIndex - right.modelIndex))
        return { grouped: false, sections: [], rows }
      }, [allRows, pane, query, searching])

      const effortChoices = useMemo(() => {
        if (reasoning === undefined) return []
        return [
          ...reasoning.defaultEffort === undefined
            ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
            : [],
          ...reasoning.efforts.map(level => ({ key: `effort:${level.id}`, effort: level.id, label: level.name })),
        ]
      }, [reasoning, t])

      const showEffortRow = reasoning !== undefined && pane !== 'effort'
      const effortPane = pane === 'effort'

      /** Flattened display order: what the keyboard and the jump chords index into. */
      const visibleRows = useMemo(() => (effortPane
        ? effortChoices.map(choice => ({ kind: 'effort', choice }))
        : listed.rows.map(row => ({ kind: 'model', row }))), [effortChoices, effortPane, listed.rows])

      /** Cmd/Ctrl+1..9 for the first nine visible rows. */
      const jumpLabels = useMemo(() => {
        const labels = new Map()
        for (let index = 0; index < Math.min(JUMP_COUNT, visibleRows.length); index += 1) {
          const entry = visibleRows[index]
          labels.set(entry.kind === 'model' ? entry.row.key : entry.choice.key, jumpLabel(index))
        }
        return labels
      }, [visibleRows])

      const busy = state.status === 'selecting'
      const waiting = current === null && state.status === 'loading'

      const modelLabel = waiting
        ? t('trigger.loading')
        : currentRow?.model.name
          ?? (current === null ? t('trigger.fallback') : `${current.provider}/${current.model}`)
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      const triggerAria = waiting
        ? t('trigger.loading')
        : current === null
          ? t('trigger.fallback')
          : effortLabel === undefined
            ? t('trigger.aria', { model: modelLabel })
            : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
      const triggerUnavailable = currentRow?.unavailable === true
        || (current !== null && routableKnown && !routableSet.has(current.provider))

      const reload = useCallback(() => {
        lastActionRef.current = 'load'
        load()
      }, [load])

      const close = useCallback((restoreFocus) => {
        setOpen(false)
        setPane('favorites')
        setQuery('')
        setHighlight(0)
        if (restoreFocus === true) queueMicrotask(() => { triggerRef.current?.focus() })
      }, [])

      const show = useCallback(() => {
        triggerRef.current?.focus()
        setPane(favoriteList.length > 0 ? 'favorites' : (current?.provider ?? 'favorites'))
        setQuery('')
        setHighlight(0)
        setOpen(true)
        reload()
        routable.load()
      }, [current, favoriteList.length, reload, routable])

      const submit = useCallback((selection) => {
        lastActionRef.current = 'select'
        triggerRef.current?.focus()
        void select(selection).then((result) => {
          if (result === undefined) return
          if (result.ok) {
            close(true)
            return
          }
          toastSeq.current += 1
          setToast({
            seq: toastSeq.current,
            text: result.error.code === 'session/writer-held'
              ? t('error.sessionInUse')
              : t('error.action', { message: `${result.error.code}: ${result.error.message}` }),
          })
        })
      }, [close, select, t])

      const chooseModel = useCallback((row) => {
        if (current !== null && current.provider === row.provider && current.model === row.model.id) {
          close(true)
          return
        }
        submit({
          provider: row.provider,
          model: row.model.id,
          ...row.model.reasoning?.defaultEffort === undefined
            ? {}
            : { reasoningEffort: row.model.reasoning.defaultEffort },
        })
      }, [close, current, submit])

      const chooseEffort = useCallback((effort) => {
        if (current === null) return
        if (effectiveEffort === effort) {
          close(true)
          return
        }
        submit({
          provider: current.provider,
          model: current.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        })
      }, [close, current, effectiveEffort, submit])

      const activate = useCallback((entry) => {
        if (entry === undefined) return
        if (entry.kind === 'effort') chooseEffort(entry.choice.effort)
        else chooseModel(entry.row)
      }, [chooseEffort, chooseModel])

      // Focus the search field whenever the card opens, mirroring T3.
      useLayoutEffect(() => {
        if (!open) return
        searchRef.current?.focus({ preventScroll: true })
        const frame = window.requestAnimationFrame(() => {
          searchRef.current?.focus({ preventScroll: true })
        })
        return () => { window.cancelAnimationFrame(frame) }
      }, [open])

      // Highlight always names a live row of the shown pane.
      useEffect(() => {
        if (!open) return
        setHighlight(0)
      }, [open, pane, query])

      useEffect(() => {
        if (highlight >= visibleRows.length) setHighlight(0)
      }, [highlight, visibleRows.length])

      useEffect(() => {
        if (!open) return
        rowRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
      }, [highlight, open])

      // Outside press closes the card.
      useEffect(() => {
        if (!open) return
        const onMouseDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (panelRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onMouseDown)
        return () => { document.removeEventListener('mousedown', onMouseDown) }
      }, [open])

      // Jump chords stay document-wide so a keystroke works while the composer
      // editor or a row holds focus.
      useEffect(() => {
        if (!open) return
        const onKeyDown = (event) => {
          if (busy) return
          const index = jumpIndexFromEvent(event)
          if (index === null) return
          const entry = visibleRows[index]
          if (entry === undefined) return
          if (entry.kind === 'model' && entry.row.unavailable && entry.row.provider !== current?.provider) return
          event.preventDefault()
          event.stopPropagation()
          activate(entry)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => { window.removeEventListener('keydown', onKeyDown, true) }
      }, [activate, busy, current, open, visibleRows])

      // Portaled placement above the trigger, right edges aligned.
      useLayoutEffect(() => {
        if (!open) { setMenuPos(null); return }
        const place = () => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const width = panelRef.current?.offsetWidth ?? PANEL_WIDTH
          const height = panelRef.current?.offsetHeight ?? PANEL_MAX_HEIGHT
          let left = rect.right - width
          let top = rect.top - 8 - height
          left = Math.min(Math.max(left, PANEL_MARGIN), window.innerWidth - width - PANEL_MARGIN)
          top = Math.min(Math.max(top, PANEL_MARGIN), window.innerHeight - height - PANEL_MARGIN)
          setMenuPos({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, pane, query, state, listed])

      if (!available) return null

      const moveHighlight = (delta) => {
        const count = visibleRows.length
        if (count === 0) return
        setHighlight((previous) => (previous + delta + count) % count)
      }

      const onPanelKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (effortPane) {
            setPane('favorites')
            return
          }
          close(true)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const active = document.activeElement
          if (active instanceof HTMLButtonElement && active.dataset.t3mpRow !== undefined) {
            const index = rowRefs.current.indexOf(active)
            if (index !== -1) {
              event.preventDefault()
              moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
              return
            }
          }
          if (active instanceof HTMLButtonElement && active.dataset.t3mpRail !== undefined) return
          event.preventDefault()
          moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Enter') {
          if (document.activeElement === searchRef.current) {
            event.preventDefault()
            activate(visibleRows[highlight])
          }
        }
      }

      const onPanelBlur = (event) => {
        if (event.relatedTarget instanceof Node && (
          rootRef.current?.contains(event.relatedTarget) === true
          || panelRef.current?.contains(event.relatedTarget) === true
        )) return
        setOpen(false)
      }

      const railSelect = (id) => {
        setPane(id)
        setQuery('')
        setHighlight(0)
        searchRef.current?.focus({ preventScroll: true })
      }

      const onRailKeyDown = (event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          searchRef.current?.focus({ preventScroll: true })
        }
      }

      const onSearchKeyDown = (event) => {
        if (event.key === 'ArrowRight' && query.length === 0 && !searching) {
          event.preventDefault()
          railRef.current?.querySelector('button')?.focus()
          return
        }
        if (event.key === 'Tab' && event.shiftKey && !searching) {
          event.preventDefault()
          railRef.current?.querySelector('button')?.focus()
        }
      }

      rowRefs.current = []

      const renderModelRow = (row, index) => {
        const isFavorite = favoriteKeys.has(row.key)
        const isSelected = current !== null
          && current.provider === row.provider
          && current.model === row.model.id
        const label = jumpLabels.get(row.key)
        const disabled = busy
          || (row.unavailable && current?.provider !== row.provider)
        return h('button', {
          key: row.key,
          ref: (node) => { rowRefs.current[index] = node },
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': isSelected,
          'aria-disabled': disabled || undefined,
          'data-t3mp-row': '',
          className: [
            't3mp-row',
            isSelected && 't3mp-row-selected',
            highlight === index && 't3mp-row-active',
            disabled && 't3mp-row-disabled',
          ].filter(Boolean).join(' '),
          disabled,
          onMouseEnter: () => { setHighlight(index) },
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => { chooseModel(row) },
        },
          h('span', { className: 't3mp-row-main' },
            h('span', { className: 't3mp-row-title' },
              h('span', { className: 't3mp-row-name' }, row.model.name),
              row.unavailable ? h('span', { className: 't3mp-badge' }, t('badge.unavailable')) : null,
            ),
            h('span', { className: 't3mp-row-footer' },
              h(ProviderGlyph, { providerId: row.provider, name: row.providerName, className: 't3mp-row-glyph' }),
              h('span', { className: 't3mp-row-provider' }, row.providerName),
            ),
          ),
          h('span', { className: 't3mp-row-end' },
            isSelected ? h(CheckIcon, { className: 't3mp-check' }) : null,
            label !== undefined ? h('kbd', { className: 't3mp-kbd', title: t('shortcut.aria', { label }) }, label) : null,
            h('span', {
              role: 'button',
              tabIndex: -1,
              className: isFavorite ? 't3mp-star t3mp-star-on' : 't3mp-star',
              'aria-label': isFavorite ? t('favorite.remove') : t('favorite.add'),
              'aria-pressed': isFavorite,
              title: isFavorite ? t('favorite.remove') : t('favorite.add'),
              onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
              onClick: (event) => {
                event.stopPropagation()
                favorites.toggle(row.provider, row.model.id)
              },
            }, h(StarIcon, { filled: isFavorite, className: 't3mp-star-icon' })),
          ),
        )
      }

      const renderEffortRow = (choice, index) => {
        const isSelected = effectiveEffort === choice.effort
        const label = jumpLabels.get(choice.key)
        return h('button', {
          key: choice.key,
          ref: (node) => { rowRefs.current[index] = node },
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': isSelected,
          'data-t3mp-row': '',
          className: [
            't3mp-row',
            isSelected && 't3mp-row-selected',
            highlight === index && 't3mp-row-active',
          ].filter(Boolean).join(' '),
          disabled: busy,
          onMouseEnter: () => { setHighlight(index) },
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => { chooseEffort(choice.effort) },
        },
          h('span', { className: 't3mp-row-main' },
            h('span', { className: 't3mp-row-title' },
              h('span', { className: 't3mp-row-name' }, choice.label),
            ),
          ),
          h('span', { className: 't3mp-row-end' },
            isSelected ? h(CheckIcon, { className: 't3mp-check' }) : null,
            label !== undefined ? h('kbd', { className: 't3mp-kbd' }, label) : null,
          ),
        )
      }

      const renderSection = (section) => h('div', { className: 't3mp-section', key: section.id },
        h('div', { className: 't3mp-section-head' },
          h(ProviderGlyph, { providerId: section.id, name: section.name, className: 't3mp-section-glyph' }),
          h('span', { className: 't3mp-section-name' }, section.name),
          section.unavailable ? h('span', { className: 't3mp-badge' }, t('badge.unavailable')) : null,
        ),
        section.rows.map(row => renderModelRow(row, listed.rows.indexOf(row))),
      )

      const resultNodes = effortPane
        ? visibleRows.map((entry, index) => renderEffortRow(entry.choice, index))
        : listed.grouped
          ? listed.sections.map(renderSection)
          : listed.rows.map((row, index) => renderModelRow(row, index))

      const empty = state.status === 'ready' && visibleRows.length === 0

      const rail = searching ? null : h('div', {
        ref: railRef,
        className: 't3mp-rail',
        role: 'toolbar',
        'aria-label': t('rail.aria'),
        'aria-orientation': 'vertical',
        onKeyDown: onRailKeyDown,
      },
        h('div', { className: 't3mp-rail-inner' },
          h('button', {
            type: 'button',
            'data-t3mp-rail': 'favorites',
            className: pane === 'favorites' ? 't3mp-rail-button t3mp-rail-on' : 't3mp-rail-button',
            'aria-pressed': pane === 'favorites',
            'aria-label': t('rail.favorites'),
            title: t('rail.favorites'),
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { railSelect('favorites') },
          }, h(StarIcon, { filled: true, className: 't3mp-rail-icon' })),
          h('div', { className: 't3mp-rail-divider' }),
          providers.map(provider => h('button', {
            key: provider.id,
            type: 'button',
            'data-t3mp-rail': provider.id,
            className: pane === provider.id ? 't3mp-rail-button t3mp-rail-on' : 't3mp-rail-button',
            'aria-pressed': pane === provider.id,
            'aria-label': provider.name,
            title: routableKnown && !routableSet.has(provider.id)
              ? `${provider.name} — ${t('badge.unavailable')}`
              : provider.name,
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { railSelect(provider.id) },
          }, h(ProviderGlyph, { providerId: provider.id, name: provider.name, className: 't3mp-rail-glyph' }))),
        ),
      )

      const header = h('div', { className: 't3mp-search' },
        h('div', { className: 't3mp-search-inner' },
          h(SearchIcon, { className: 't3mp-search-icon' }),
          h('input', {
            ref: searchRef,
            className: 't3mp-search-input',
            type: 'text',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.placeholder'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => { setQuery(event.target.value) },
            onKeyDown: onSearchKeyDown,
            onMouseDown: (event) => { event.stopPropagation() },
          }),
        ),
      )

      const statusNodes = []
      if (effortPane) {
        statusNodes.push(h('div', { className: 't3mp-pane-head', key: 'pane-head' },
          h('button', {
            type: 'button',
            className: 't3mp-back',
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { setPane('favorites') },
          }, h(ChevronRightIcon, { className: 't3mp-back-icon' }), t('effort.back')),
          h('span', { className: 't3mp-pane-title' }, t('effort.title')),
        ))
      } else {
        if (state.status === 'loading') {
          statusNodes.push(h('div', { className: 't3mp-status', key: 'loading' }, t('status.loading')))
        }
        if (state.error !== null && lastActionRef.current === 'load') {
          statusNodes.push(h('div', { className: 't3mp-error', key: 'error' },
            h('span', {}, t('error.load', { message: state.error })),
            h('button', { type: 'button', className: 't3mp-retry', onClick: reload }, t('action.retry')),
          ))
        }
        for (const failure of state.failures) {
          statusNodes.push(h('div', { className: 't3mp-warning', key: `failure:${failure.id}` },
            h('span', {}, t('warning.groupLoad', { name: failure.name, message: failure.message })),
            h('button', { type: 'button', className: 't3mp-retry', onClick: reload }, t('action.retry')),
          ))
        }
      }

      const effortRow = showEffortRow && h('button', {
        type: 'button',
        className: 't3mp-effort-row',
        disabled: current === null,
        onMouseDown: (event) => { event.preventDefault() },
        onClick: () => { setPane('effort') },
      },
        h('span', { className: 't3mp-effort-label' }, t('effort.row')),
        h('span', { className: 't3mp-effort-value' }, effortLabel ?? ''),
        h(ChevronRightIcon, { className: 't3mp-effort-chevron' }),
      )

      const panel = h('div', {
        ref: panelRef,
        className: 't3mp-panel',
        style: menuPos ?? { visibility: 'hidden', left: 0, top: 0 },
        role: 'dialog',
        'aria-label': t('panel.aria'),
        onKeyDown: onPanelKeyDown,
        onBlur: onPanelBlur,
      },
        rail,
        h('div', { className: rail === null ? 't3mp-main t3mp-main-full' : 't3mp-main' },
          header,
          statusNodes,
          h('div', { className: 't3mp-list scrollable' }, resultNodes),
          empty ? h('div', { className: 't3mp-empty' }, t('empty.models')) : null,
          effortRow,
        ),
      )

      return h('div', {
        ref: rootRef,
        className: 't3mp-root',
        onBlur: onPanelBlur,
        onMouseDown: (event) => {
          if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
        },
      },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 't3mp-trigger',
          'aria-label': triggerAria,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: triggerLabel,
          disabled: locked,
          onClick: () => { if (open) close(true); else show() },
        },
          current !== null
            ? h(ProviderGlyph, { providerId: current.provider, name: currentRow?.providerName ?? current.provider, className: 't3mp-trigger-glyph' })
            : h(ChevronDownIcon, { className: 't3mp-trigger-fallback' }),
          h('span', { className: 't3mp-trigger-label' }, modelLabel),
          triggerUnavailable
            ? h('span', { className: 't3mp-badge' }, t('badge.unavailable'))
            : null,
          h(ChevronDownIcon, { className: open ? 't3mp-chevron t3mp-chevron-open' : 't3mp-chevron' }),
        ),
        open ? ReactDOM.createPortal(panel, document.body) : null,
        toast === null ? null : h('div', { key: toast.seq, className: 't3mp-toast', role: 'status' }, toast.text),
      )
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
.t3mp-root { position: relative; min-width: 0; }

.t3mp-trigger {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  max-width: 220px; max-width: min(360px, 45cqw); height: 28px; padding: 0 4px 0 8px;
  border: none; border-radius: 24px; outline: none; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer;
}
.t3mp-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.t3mp-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.t3mp-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.t3mp-trigger-label {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: var(--dsh-composer-model-text-display, block);
}
.t3mp-trigger-glyph, .t3mp-trigger-fallback { flex: 0 0 auto; }
.t3mp-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.t3mp-chevron-open { transform: rotate(180deg); }

.t3mp-badge {
  flex: 0 0 auto; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px; color: var(--dsw-alias-label-caption);
  font-size: 10px; line-height: 15px; font-weight: 500; white-space: nowrap;
}

.t3mp-panel {
  position: fixed; z-index: 1100; display: flex; flex-direction: row;
  width: ${PANEL_WIDTH}px; max-width: calc(100vw - 24px);
  height: ${PANEL_MAX_HEIGHT}px; max-height: calc(100vh - 24px);
  overflow: hidden; padding: 0; border: 0; border-radius: 16px;
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  font-family: var(--dsw-font-family);
}

.t3mp-rail { width: 44px; flex: 0 0 44px; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
.t3mp-rail-inner { display: flex; flex-direction: column; gap: 4px; padding: 4px; height: 100%; overflow-y: auto; }
.t3mp-rail-inner::-webkit-scrollbar { display: none; }
.t3mp-rail-button {
  position: relative; display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; flex: 0 0 auto; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0;
  transition: background-color 120ms ease;
}
.t3mp-rail-button:hover { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-rail-button:focus-visible { outline: none; background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-rail-on::after {
  content: ''; position: absolute; right: -4px; top: 50%; width: 3px; height: 20px;
  transform: translateY(-50%); border-radius: 999px 0 0 999px; background: var(--dsw-alias-brand-primary);
}
.t3mp-rail-divider { height: 1px; margin: 0 2px 4px; background: var(--dsw-alias-border-l1); }
.t3mp-rail-icon { color: var(--dsw-alias-label-primary); }

.t3mp-main { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 40%, transparent); }
.t3mp-main-full { border-left: none; }
.t3mp-rail + .t3mp-main { border-left: 1px solid var(--dsw-alias-border-l1); }

.t3mp-search { padding: 8px 8px 0; flex: 0 0 auto; }
.t3mp-search-inner {
  display: flex; align-items: center; gap: 6px; height: 30px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 10px;
}
.t3mp-search-inner:focus-within { border-bottom-color: var(--dsw-alias-border-l3); }
.t3mp-search-icon { flex: 0 0 auto; color: var(--dsw-alias-label-caption); opacity: 0.7; }
.t3mp-search-input {
  flex: 1 1 auto; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 26px; font-family: inherit; padding: 0;
}
.t3mp-search-input::placeholder { color: var(--dsw-alias-label-caption); }

.t3mp-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px 2px 6px 8px; }
.t3mp-status, .t3mp-empty { padding: 12px 12px; color: var(--dsw-alias-label-caption); font-size: 12px; }
.t3mp-error, .t3mp-warning {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 6px 8px; padding: 6px 8px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.t3mp-warning { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.t3mp-retry {
  border: none; background: transparent; color: var(--dsw-alias-link);
  font: inherit; cursor: pointer; padding: 0 4px; flex: 0 0 auto;
}

.t3mp-section { margin-bottom: 4px; }
.t3mp-section-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px 2px; }
.t3mp-section-glyph, .t3mp-row-glyph { transform: scale(0.75); transform-origin: left center; }
.t3mp-section-glyph { transform: scale(0.875); }
.t3mp-section-name { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: var(--dsw-alias-label-caption); text-transform: none; }

.t3mp-row {
  display: flex; align-items: center; gap: 12px; width: 100%; max-width: 100%; min-width: 0;
  padding: 8px; border: none; border-radius: 8px; background: transparent;
  color: inherit; text-align: left; cursor: pointer; font-family: inherit;
  transition: background-color 100ms ease, color 100ms ease;
}
.t3mp-row + .t3mp-row { margin-top: 2px; }
.t3mp-row-active, .t3mp-row:hover { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-row-selected { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.t3mp-row-selected.t3mp-row-active { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-row-disabled { opacity: 0.5; cursor: not-allowed; }
.t3mp-row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.t3mp-row-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.t3mp-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; line-height: 1.35; }
.t3mp-row-footer { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--dsw-alias-label-caption); }
.t3mp-row-provider { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 400; line-height: 1.35; }
.t3mp-row-end { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.t3mp-check { color: var(--dsw-alias-label-primary); flex: 0 0 auto; }
.t3mp-kbd {
  display: inline-flex; align-items: center; height: 16px; padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent);
  color: var(--dsw-alias-label-caption); font-family: inherit; font-size: 10px; line-height: 1;
}
.t3mp-star {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
  color: var(--dsw-alias-label-caption); opacity: 0.64; transition: opacity 100ms ease, color 100ms ease;
}
.t3mp-row:hover .t3mp-star, .t3mp-row-active .t3mp-star { opacity: 1; }
.t3mp-star-on { opacity: 1; color: #eab308; }

.t3mp-effort-row {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  margin: 0; padding: 8px 12px; border: none; border-top: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.t3mp-effort-row:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-effort-row:disabled { opacity: 0.5; cursor: default; }
.t3mp-effort-label { flex: 0 0 auto; color: var(--dsw-alias-label-caption); }
.t3mp-effort-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.t3mp-effort-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); }

.t3mp-pane-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 4px; flex: 0 0 auto; }
.t3mp-back {
  display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent;
  color: var(--dsw-alias-link); font-family: inherit; font-size: 12px; cursor: pointer; padding: 0;
}
.t3mp-back-icon { transform: rotate(180deg); }
.t3mp-pane-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-caption); }

.t3mp-trigger-glyph, .t3mp-rail-glyph, .t3mp-row-glyph, .t3mp-section-glyph {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 4px; flex: 0 0 auto;
  background: color-mix(in srgb, var(--t3mp-accent) 22%, transparent);
  color: var(--t3mp-accent);
  font-size: 8px; font-weight: 700; line-height: 1; letter-spacing: -0.02em;
}
.t3mp-rail-glyph { width: 24px; height: 24px; border-radius: 6px; font-size: 10px; }
.t3mp-section-glyph { width: 12px; height: 12px; font-size: 7px; border-radius: 3px; }

.t3mp-toast {
  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 1200;
  max-width: 320px; padding: 8px 10px; border-radius: 10px;
  background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.4;
}
`

    // ------------------------------------------------------------------ apply

    /**
     * Required client services: the seat registry, locale, the model faces, and
     * the remote namespaces. `remote.session` is listed because
     * `modelDirectories.directoryFor` runs behind the caller-context tracker,
     * and because this plugin reads the catalog for provider availability.
     */
    const inject = ['slots', 'locale', 'sessions', 'modelDirectories', 'remote', 'remote.session']

    /**
     * Client plugin body: register the plugin's dictionaries and shadow the
     * composer model seat with the T3 picker.
     * @param ctx - the plugin's client context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 't3-model-picker: dictionaries')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.t3ModelPicker = ''
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 't3-model-picker: styles')

      const favorites = createFavoritesStore()
      const routable = createRoutableStore(ctx.remote)

      const refresh = () => { void routable.load() }
      ctx.on('connection/reset', refresh)
      ctx.remote.$on('llm/adapters-updated', refresh)
      ctx.remote.$on('settings/document-updated', refresh)

      ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
        name: 'conversation.input.model',
        // Lower than the shipped seat's default 0: same cell, different
        // priority, so this entry is the one the composer renders.
        priority: -1,
        locale: NS,
        inject: (sessionId) => {
          const directory = ctx.modelDirectories.directoryFor(sessionId)
          const sessions = ctx.sessions
          const available = sessions.subagentAddress(sessionId) === undefined
          return {
            available,
            directory: directory.store,
            load: () => {
              if (available) directory.load().catch(() => { /* surfaced on the store */ })
            },
            select: selection => available
              ? directory.select(selection)
              : Promise.resolve(undefined),
            favorites,
            routable,
          }
        },
      }, ModelPicker))
    }

    return { inject, apply }
  },
})
