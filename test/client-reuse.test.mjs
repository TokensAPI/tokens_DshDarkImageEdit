import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function clientHarness(savedPrompts = []) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registrations = new Map()
  const listeners = []
  const effects = []
  const storage = new Map([['dsh-dark-image-edit.prompts.v1', JSON.stringify(savedPrompts)]])
  const sessions = {
    list: { subscribe() { return () => {} }, getSnapshot() { return { current: 'session-a' } } },
    binding() { return undefined },
  }
  const conversation = {}
  const componentStates = new Map()
  let currentState
  let hookIndex = 0
  const React = {
    useState(initial) {
      const state = currentState
      const index = hookIndex++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in currentState)) currentState[index] = { current: initial }
      return currentState[index]
    },
    useEffect(effect) { effects.push(effect) },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
  }
  const jsx = { jsx(type, props) { return { type, props } }, jsxs(type, props) { return { type, props } }, Fragment: Symbol('Fragment') }
  class Element { closest(selector) { return selector === '[data-composer-card]' ? this : null } }
  class File {
    constructor(parts, name, options) {
      this.bytes = Buffer.concat(parts.map((part) => Buffer.from(part)))
      this.name = name
      this.type = options.type
    }
  }
  let definition
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    document: {
      addEventListener(name, handler, capture) { listeners.push({ name, handler, capture: Boolean(capture) }) },
      removeEventListener() {},
      body: {},
    },
    localStorage: { getItem(key) { return storage.get(key) ?? null }, setItem(key, value) { storage.set(key, value) } },
    Element,
    File,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
  })
  const plugin = definition.factory((name) => {
    if (name === 'react/jsx-runtime') return jsx
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal(node) { return node } }
    throw new Error(`Unexpected module: ${name}`)
  })
  plugin.apply({
    get(name) { return name === 'sessions' ? sessions : name === 'conversation' ? conversation : undefined },
    slots: {
      inject(_name, register) { register() },
      register(options, component) { registrations.set(options.name, { options, component }) },
    },
  })
  function render(component, props) {
    const previous = currentState
    const previousIndex = hookIndex
    currentState = componentStates.get(component) ?? []
    componentStates.set(component, currentState)
    hookIndex = 0
    try { return component(props) } finally { currentState = previous; hookIndex = previousIndex }
  }
  return { registrations, listeners, effects, sessions, jsx, Element, render, storage }
}

function findElement(node, predicate) {
  if (Array.isArray(node)) return node.map((item) => findElement(item, predicate)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

test('saved prompt can be appended to a plain draft without submitting it', async () => {
  const harness = await clientHarness([{ id: 'p1', title: '换背景', text: '只修改背景' }])
  const entry = harness.registrations.get('conversation.input.left')
  assert.equal(entry.options.id, 'dark-image-edit-prompts')
  let written
  const props = {
    useInput() { return { draft: '保持主体', phase: 'plain', occurrences: [] } },
    inputActions: { setDraft(value) { written = value } },
  }
  let tree = harness.render(entry.component, props)
  const toggle = findElement(tree, (node) => node.type === 'button' && node.props['aria-label'] === '常用提示词')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(findElement(tree, (node) => node.props?.role === 'dialog'), undefined)
  toggle.props.onClick()
  tree = harness.render(entry.component, props)
  assert.ok(findElement(tree, (node) => node.props?.role === 'dialog' && node.props['aria-label'] === '常用提示词'))
  const button = findElement(tree, (node) => node.type === 'button' && node.props.title === '只修改背景')
  assert.ok(button)
  button.props.onClick()
  assert.equal(written, '保持主体\n只修改背景')
  tree = harness.render(entry.component, props)
  assert.equal(findElement(tree, (node) => node.props?.role === 'dialog'), undefined)
})

test('prompt editor persists a changed reusable prompt', async () => {
  const harness = await clientHarness([{ id: 'p1', title: '换背景', text: '旧提示词' }])
  const component = harness.registrations.get('conversation.input.left').component
  const props = { useInput() { return { draft: '', phase: 'plain', occurrences: [] } }, inputActions: { setDraft() {} } }
  let tree = harness.render(component, props)
  findElement(tree, (node) => node.type === 'button' && node.props['aria-label'] === '常用提示词').props.onClick()
  tree = harness.render(component, props)
  findElement(tree, (node) => node.type === 'button' && node.props['aria-label'] === '编辑 换背景').props.onClick()
  tree = harness.render(component, props)
  findElement(tree, (node) => node.type === 'textarea').props.onChange({ target: { value: '新提示词' } })
  tree = harness.render(component, props)
  findElement(tree, (node) => node.type === 'button' && node.props.children === '保存').props.onClick()
  assert.equal(JSON.parse(harness.storage.get('dsh-dark-image-edit.prompts.v1'))[0].text, '新提示词')
})

test('internal image drop reuses the current session attachment through host file intake', async () => {
  const harness = await clientHarness()
  const bytes = Buffer.from([1, 2, 3, 4])
  harness.sessions.binding = (id) => id === 'session-a' ? {
    session: { async readAttachment(attachmentId) {
      assert.equal(attachmentId, 'sha256:original')
      return { ok: true, value: { data: bytes, attachment: { mediaType: 'image/png', name: 'base.png' } } }
    } },
  } : undefined
  let added
  const props = {
    attachments: [],
    canAcceptDrop: true,
    onAddFiles(files) { added = files },
    onRemoveAttachment() {},
    uploads: {},
    onRetryFile() {},
    inputActions: {},
    sessions: harness.sessions,
    conversation: {},
  }
  const wrapper = harness.render(harness.registrations.get('conversation.input.attachments').component, props)
  harness.render(wrapper.type, wrapper.props)
  for (const effect of harness.effects) effect()
  const drop = harness.listeners.find((item) => item.name === 'drop' && item.capture)
  assert.ok(drop)
  let prevented = false
  await drop.handler({
    target: new harness.Element(),
    dataTransfer: {
      types: ['application/x-dsh-dark-image-edit-image'],
      getData() { return JSON.stringify({ sessionId: 'session-a', attachmentId: 'sha256:original', name: 'base.png' }) },
    },
    preventDefault() { prevented = true },
    stopPropagation() {},
  })
  assert.equal(prevented, true)
  assert.equal(added.length, 1)
  assert.equal(added[0].name, 'base.png')
  assert.equal(added[0].type, 'image/png')
  assert.deepEqual(added[0].bytes, bytes)
})

test('historical image exposes a drag reference only for a durable attachment', async () => {
  const harness = await clientHarness()
  const entry = harness.registrations.get('conversation.message.images')
  assert.equal(entry.options.priority, -1)
  const attachment = { attachmentId: 'sha256:original', mediaType: 'image/png', name: 'base.png' }
  const wrapper = harness.render(entry.component, { images: [{ attachment }], loadImage: Object.assign(async () => 'blob:image', { peek: () => 'blob:image' }), align: 'end' })
  const gallery = harness.render(wrapper.type, wrapper.props)
  const imageElement = gallery.props.children[0]
  const imageTree = harness.render(imageElement.type, imageElement.props)
  const button = findElement(imageTree, (node) => node.type === 'button' && node.props.draggable === true)
  assert.ok(button)
  const data = new Map()
  button.props.onDragStart({ dataTransfer: { effectAllowed: '', setData(type, value) { data.set(type, value) } } })
  const payload = JSON.parse(data.get('application/x-dsh-dark-image-edit-image'))
  assert.equal(payload.sessionId, 'session-a')
  assert.equal(payload.attachmentId, 'sha256:original')
})
