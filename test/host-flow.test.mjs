import { test } from 'node:test'
import assert from 'node:assert/strict'

// Minimal PNG byte buffer (signature + IHDR width/height 400x300 + padding) so
// detectImageMediaType returns image/png and imageDimensions reads 400x300.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),            // IHDR length
  Buffer.from([0x49, 0x48, 0x44, 0x52]),            // 'IHDR'
  Buffer.from([0x00, 0x00, 0x01, 0x90]),            // width 400
  Buffer.from([0x00, 0x00, 0x01, 0x2c]),            // height 300
  Buffer.alloc(40, 0),
])

const config = {
  baseURL: 'https://tokensapi.test/v1',
  apiKeyEnv: 'TOKENSAPI_API_KEY',
  pollIntervalMs: 1,
  maxPollMs: 200,
  defaultEditModel: 'qwen_image',
  allowLocalImageInput: true,
  maxInputImageBytes: 30 * 1024 * 1024,
  imageUploadURL: 'https://tokensapi.test/v1/assets/images',
  uploadAuthMode: 'api_key',
  accountAccessTokenEnv: 'TOKENSAPI_ACCOUNT_ACCESS_TOKEN',
  accountUserId: '',
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
}

// 不同附件返回不同尺寸的 PNG，便于验证“参考哪一张尺寸”的提问结果。
function pngWithSize(width, height) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),            // IHDR length
    Buffer.from([0x49, 0x48, 0x44, 0x52]),            // 'IHDR'
    Buffer.from([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff]),
    Buffer.from([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff]),
    Buffer.alloc(40, 0),
  ])
}

const SIZES_BY_ATTACHMENT = {
  'sha256:img1': [400, 300],     // 4:3
  'sha256:img2': [1920, 1080],   // 16:9
  'sha256:img3': [300, 400],     // 3:4
}

function buildCtx(overrides = {}) {
  const tools = []
  const promptSections = []
  const userImageCount = overrides.userImageCount ?? 1
  const aspectReferenceAnswer = overrides.aspectReferenceAnswer ?? '第一张'
  const askedQuestions = []
  let concluded = false
  const attachments = {
    async readImage(ref) {
      const [width, height] = SIZES_BY_ATTACHMENT[String(ref?.attachmentId ?? '')] ?? [400, 300]
      return { data: pngWithSize(width, height), ref: { mediaType: 'image/png' } }
    },
    async saveImage(input) {
      return { attachmentId: 'sha256:result', mediaType: input.mediaType, bytes: input.data.length, width: 512, height: 512, name: input.name }
    },
  }
  const ctx = {
    get(name) { return name === 'attachments' ? attachments : undefined },
    tools: { register(spec) { tools.push(spec) } },
    credentials: { async resolve() { return { value: 'test-api-key' } } },
    systemPrompt: { section(spec) { promptSections.push(spec) } },
    webServer: { register() {} },
    effect(fn) { fn(); return () => {} },
    userQuestions: {
      async ask({ questions }) {
        for (const question of questions) askedQuestions.push(question)
        return { answers: questions.map((question) => ({ id: question.id, selected: [aspectReferenceAnswer] })) }
      },
    },
    ...overrides,
  }
  const exec = {
    signal: new AbortController().signal,
    concludeTurn() { concluded = true },
    agent: {
      session: {
        deriveMessages() {
          const content = []
          for (let index = 0; index < userImageCount; index += 1) {
            content.push({ type: 'image', attachment: { attachmentId: `sha256:img${index + 1}`, mediaType: 'image/png' } })
          }
          return [{ role: 'user', content }]
        },
      },
    },
  }
  return {
    ctx, tools, promptSections, exec, askedQuestions,
    get concluded() { return concluded },
  }
}

function installFetchMock() {
  const original = globalThis.fetch
  let statusCalls = 0
  let lastSubmitBody = null
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const method = (init.method || 'GET').toUpperCase()
    if (u.includes('/v1/assets/images') && method === 'POST') {
      return jsonResponse({
        upload_url: 'https://upload.tokensapi.ai/abc',
        access_url: 'https://s3.tokensapi.ai/out.png',
        upload_method: 'PUT',
        required_headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.length), 'host': 'upload.tokensapi.ai' },
      })
    }
    if (u.startsWith('https://upload.') && method === 'PUT') {
      return new Response(null, { status: 200 })
    }
    if (u.includes('/tasks/images') && method === 'POST') {
      lastSubmitBody = JSON.parse(init.body)
      return jsonResponse({ task_id: 'task1' })
    }
    if (u.includes('/tasks/task1') && method === 'GET') {
      statusCalls += 1
      if (statusCalls === 1) return jsonResponse({ task_id: 'task1', status: 'running', progress: 10 })
      return jsonResponse({ task_id: 'task1', status: 'succeeded', results: [{ url: 'https://s3.tokensapi.ai/out.png' }] })
    }
    if (u === 'https://s3.tokensapi.ai/out.png') {
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
    }
    throw new Error('unexpected fetch: ' + u)
  }
  return {
    restore() { globalThis.fetch = original },
    get submitBody() { return lastSubmitBody },
  }
}

test('apply() registers the image_edit tool and a system prompt section', async () => {
  const mod = await import('../dist/index.js')
  const { ctx, tools, promptSections } = buildCtx()
  mod.apply(ctx, config)

  const imageEdit = tools.find((tool) => tool.name === 'image_edit')
  assert.ok(imageEdit, 'image_edit tool should be registered')
  assert.equal(typeof imageEdit.execute, 'function')
  assert.ok(imageEdit.parameters.required.includes('prompt'))
  assert.deepEqual(imageEdit.parameters.properties.n.enum, [1, 2, 4])
  assert.deepEqual(imageEdit.parameters.properties.aspect_ratio.enum, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])

  const statusTool = tools.find((tool) => tool.name === 'image_edit_status')
  assert.ok(statusTool, 'image_edit_status tool should be registered')

  assert.ok(promptSections.length >= 1)
  assert.match(promptSections[0].text, /image_edit/)
})

test('image_edit execute runs the full upload->submit->poll->save flow (mock)', async () => {
  const mock = installFetchMock()
  try {
    const mod = await import('../dist/index.js')
    const state = buildCtx()
    mod.apply(state.ctx, config)

    const imageEdit = state.tools.find((tool) => tool.name === 'image_edit')
    const result = await imageEdit.execute({ prompt: 'make it sunset', image: 'dsh-attachment:latest' }, state.exec)

    assert.equal(result.taskId, 'task1')
    assert.equal(result.model, 'qwen_image')
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].attachmentId, 'sha256:result')
    assert.equal(result.images[0].mediaType, 'image/png')
    assert.ok(state.concluded, 'concludeTurn should be called after a successful generation')

    // 自动测量：PNG 400x300 → 最接近比例 4:3（未显式传 aspect_ratio）
    assert.equal(mock.submitBody.aspect_ratio, '4:3')
    assert.equal(mock.submitBody.prompt, 'make it sunset')
  } finally {
    mock.restore()
  }
})

test('image_edit honors an explicitly requested aspect ratio', async () => {
  const mock = installFetchMock()
  try {
    const mod = await import('../dist/index.js')
    const state = buildCtx()
    mod.apply(state.ctx, config)

    const imageEdit = state.tools.find((tool) => tool.name === 'image_edit')
    await imageEdit.execute({ prompt: 'make it sunset', image: 'dsh-attachment:latest', aspect_ratio: '16:9' }, state.exec)
    assert.equal(mock.submitBody.aspect_ratio, '16:9')
  } finally {
    mock.restore()
  }
})

test('image_edit accepts up to 3 comma-separated input images and maps them to reference_1..N', async () => {
  const mock = installFetchMock()
  try {
    const mod = await import('../dist/index.js')
    const state = buildCtx({ userImageCount: 3 })
    mod.apply(state.ctx, config)

    const imageEdit = state.tools.find((tool) => tool.name === 'image_edit')
    await imageEdit.execute({ prompt: 'swap the faces', image: 'dsh-attachment:1,dsh-attachment:2,dsh-attachment:3' }, state.exec)

    const refs = mock.submitBody.input_references
    assert.equal(refs.length, 3)
    assert.deepEqual(refs.map((r) => r.slot_name), ['reference_1', 'reference_2', 'reference_3'])
    for (const ref of refs) {
      assert.equal(ref.type, 'image_url')
      assert.equal(ref.image_url.url, 'https://s3.tokensapi.ai/out.png')
    }
    // 多图未显式指定比例 → 询问参考哪一张；默认答“第一张”→ 400x300 → 4:3
    assert.equal(state.askedQuestions.length, 1)
    assert.equal(state.askedQuestions[0].id, 'dark-image-edit.aspect-reference')
    assert.deepEqual(state.askedQuestions[0].options.map((o) => o.label), ['第一张', '第二张', '第三张'])
    assert.equal(mock.submitBody.aspect_ratio, '4:3')
  } finally {
    mock.restore()
  }
})

test('image_edit uses the answered image\'s dimensions when multiple inputs are given', async () => {
  const mock = installFetchMock()
  try {
    const mod = await import('../dist/index.js')
    const state = buildCtx({ userImageCount: 3, aspectReferenceAnswer: '第二张' })
    mod.apply(state.ctx, config)

    const imageEdit = state.tools.find((tool) => tool.name === 'image_edit')
    await imageEdit.execute({ prompt: 'swap the faces', image: 'dsh-attachment:1,dsh-attachment:2,dsh-attachment:3' }, state.exec)
    // 第二张 1920x1080 → 16:9
    assert.equal(mock.submitBody.aspect_ratio, '16:9')
  } finally {
    mock.restore()
  }
})

test('image_edit does not ask for aspect ratio when an explicit one is provided', async () => {
  const mock = installFetchMock()
  try {
    const mod = await import('../dist/index.js')
    const state = buildCtx({ userImageCount: 3 })
    mod.apply(state.ctx, config)

    const imageEdit = state.tools.find((tool) => tool.name === 'image_edit')
    await imageEdit.execute({ prompt: 'swap the faces', image: 'dsh-attachment:1,dsh-attachment:2', aspect_ratio: '21:9' }, state.exec)
    assert.equal(state.askedQuestions.length, 0)
    assert.equal(mock.submitBody.aspect_ratio, '21:9')
  } finally {
    mock.restore()
  }
})

test('image_edit falls back to the first image dimensions when the question service is unavailable', async () => {
  const mock = installFetchMock()
  try {
    const mod = await import('../dist/index.js')
    const state = buildCtx({ userImageCount: 2, userQuestions: undefined })
    mod.apply(state.ctx, config)

    const imageEdit = state.tools.find((tool) => tool.name === 'image_edit')
    await imageEdit.execute({ prompt: 'merge them', image: 'dsh-attachment:1,dsh-attachment:2' }, state.exec)
    assert.equal(state.askedQuestions.length, 0)
    // 回退第一张 400x300 → 4:3
    assert.equal(mock.submitBody.aspect_ratio, '4:3')
  } finally {
    mock.restore()
  }
})

test('image_edit rejects more than 3 input images before submitting', async () => {
  const mod = await import('../dist/index.js')
  const { ctx, tools, exec } = buildCtx()
  mod.apply(ctx, config)
  const imageEdit = tools.find((tool) => tool.name === 'image_edit')

  await assert.rejects(
    imageEdit.execute({ prompt: 'x', image: 'a,b,c,d' }, exec),
    /at most 3 input images, got 4/,
  )
})

test('image_edit rejects an unsupported model or invalid count before submitting', async () => {
  const mod = await import('../dist/index.js')
  const { ctx, tools, exec } = buildCtx()
  mod.apply(ctx, config)
  const imageEdit = tools.find((tool) => tool.name === 'image_edit')

  await assert.rejects(
    imageEdit.execute({ prompt: 'x', model: 'z_image_turbo' }, exec),
    /not supported for image editing/,
  )
  await assert.rejects(
    imageEdit.execute({ prompt: 'x', n: 3 }, exec),
    /"n" must be one of \[1,2,4\]/,
  )
})
