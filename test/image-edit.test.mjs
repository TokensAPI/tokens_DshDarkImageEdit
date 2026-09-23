import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('dist bundle loads and exports the plugin contract', async () => {
  const mod = await import('../dist/index.js')
  assert.equal(mod.name, 'dark-image-edit')
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('tools'))
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.Config, 'function')
  assert.equal(typeof mod.TokensApiClient, 'function')
})

test('client bundle registers the published package name and keeps result rendering', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(pkg.name, '@tokensapi/dsh-dark-image-edit')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{\s*id: '@tokensapi\/dsh-dark-image-edit'/)
  assert.match(client, /key: 'image_edit'/)
  assert.match(client, /'aria-label': '下载图片'/)
})

test('client bundle owns no interactive wizard or composer flow', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /conversation\.composer/)
  assert.doesNotMatch(client, /pendingInteraction/)
  assert.doesNotMatch(client, /initialMediaQuestionDraft/)
  assert.doesNotMatch(client, /questions\.map\(initialMediaQuestionDraft\)/)
  assert.doesNotMatch(client, /MediaQuestionComposer/)
})

test('package metadata covers supported TokensCowork runtimes without the obsolete client runtime peer', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const supportedRange = '0.1.0-rc.8 || 0.1.3-alpha.1 || ^0.1.5-rc.2'
  const runtimePeers = [
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-tool',
  ]

  assert.equal(pkg.version, '0.1.5')
  assert.equal(pkg.dsh.engine, supportedRange)
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '>=4.0.1 <5')
  for (const name of runtimePeers) assert.equal(pkg.peerDependencies[name], supportedRange)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
})

test('default image upload configuration uses the API-key assets endpoint', async () => {
  const source = await readFile(new URL('../src/host/index.ts', import.meta.url), 'utf8')
  assert.match(source, /imageUploadURL: Schema\.string\(\)\.default\('https:\/\/tokensapi\.ai\/v1\/assets\/images'\)/)
  assert.match(source, /uploadAuthMode: Schema\.union\(\['account', 'api_key'\]\)\.default\('api_key'\)/)
})

// --- TokensApiClient network behaviour ---

const config = {
  baseURL: 'https://tokensapi.test/v1',
  apiKeyEnv: 'TOKENSAPI_API_KEY',
  pollIntervalMs: 1,
  maxPollMs: 100,
}

const ctx = {
  credentials: { async resolve() { return { value: 'test-api-key' } } },
  logger: { warn() {} },
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
}

async function withFetch(mock, callback) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await callback()
  } finally {
    globalThis.fetch = original
  }
}

test('submit retries fetch failures with one stable idempotency key', async () => {
  const { TokensApiClient } = await import('../dist/index.js')
  const client = new TokensApiClient(ctx, config)
  const keys = []
  let calls = 0

  await withFetch(async (_url, init) => {
    calls += 1
    keys.push(init.headers['Idempotency-Key'])
    if (calls === 1) throw new TypeError('fetch failed')
    return jsonResponse({ task_id: 'task_after_retry' })
  }, async () => {
    const taskId = await client.submit('images', { model: 'qwen_image', prompt: 'x', n: 1 })
    assert.equal(taskId, 'task_after_retry')
  })

  assert.equal(calls, 2)
  assert.equal(new Set(keys).size, 1)
})

test('submit reuses an existing task id for an identical repeated call', async () => {
  const { TokensApiClient } = await import('../dist/index.js')
  const client = new TokensApiClient(ctx, config)
  const keys = []
  let calls = 0

  await withFetch(async (_url, init) => {
    calls += 1
    keys.push(init.headers['Idempotency-Key'])
    return jsonResponse({ task_id: 'task_stable' })
  }, async () => {
    const a = await client.submit('images', { model: 'qwen_image', prompt: 'same' })
    const b = await client.submit('images', { model: 'qwen_image', prompt: 'same' })
    assert.equal(a, 'task_stable')
    assert.equal(b, 'task_stable')
  })

  assert.equal(calls, 1)
})

test('poll returns succeeded data and forgets the task', async () => {
  const { TokensApiClient } = await import('../dist/index.js')
  const client = new TokensApiClient(ctx, config)
  let calls = 0

  await withFetch(async () => {
    calls += 1
    if (calls === 1) return jsonResponse({ task_id: 'task', status: 'running', progress: 10 })
    return jsonResponse({ task_id: 'task', status: 'succeeded', results: [{ url: 'https://s3.tokensapi.ai/out.png' }] })
  }, async () => {
    const data = await client.poll('task')
    assert.equal(data.status, 'succeeded')
    assert.deepEqual(client.urls(data), ['https://s3.tokensapi.ai/out.png'])
  })
})

test('poll returns a recoverable timedOut result on deadline', async () => {
  const { TokensApiClient } = await import('../dist/index.js')
  const client = new TokensApiClient(ctx, { ...config, pollIntervalMs: 1000, maxPollMs: 1 })
  await withFetch(async () => jsonResponse({ task_id: 'task', status: 'running' }), async () => {
    const data = await client.poll('task')
    assert.equal(data.timedOut, true)
    assert.equal(data.recoverable, true)
  })
})

// --- Image upload grant validation ---

test('parseImageUploadGrant validates and rejects forbidden headers', async () => {
  const { parseImageUploadGrant, validateImageUploadGrant } = await import('../dist/index.js')
  const grant = parseImageUploadGrant({
    upload_url: 'https://upload.tokensapi.ai/abc',
    access_url: 'https://s3.tokensapi.ai/out.png',
    upload_method: 'PUT',
    required_headers: { 'content-type': 'image/png', 'content-length': '4', 'host': 'upload.tokensapi.ai' },
  })
  const validated = validateImageUploadGrant(grant, { mimeType: 'image/png', byteLength: 4 })
  assert.equal(validated.uploadMethod, 'PUT')
  assert.equal(validated.requiredHeaders['content-type'], 'image/png')
  assert.equal(validated.requiredHeaders.host, 'upload.tokensapi.ai')

  const bad = parseImageUploadGrant({
    upload_url: 'https://upload.tokensapi.ai/abc',
    access_url: 'https://s3.tokensapi.ai/out.png',
    upload_method: 'PUT',
    required_headers: { authorization: 'Bearer x' },
  })
  assert.throws(() => validateImageUploadGrant(bad, { mimeType: 'image/png', byteLength: 4 }), /must not require sensitive header/)
})

// --- 本地图片尺寸解析（仅文件头元数据，非 AI） ---

function pngBytes(width, height) {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    ...Buffer.alloc(16, 0),
  ])
}

function gifBytes(width, height) {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    width & 0xff, (width >>> 8) & 0xff,
    height & 0xff, (height >>> 8) & 0xff,
    ...Buffer.alloc(24, 0),
  ])
}

function jpegBytes(width, height) {
  return Buffer.from([
    0xff, 0xd8,                                      // SOI
    0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14, 0),   // APP0 (16 length)
    0xff, 0xc0, 0x00, 0x11,                          // SOF0
    0x08,                                             // precision
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    ...Buffer.alloc(32, 0),
  ])
}

function webpBytes(width, height) {
  const w = width - 1
  const h = height - 1
  return Buffer.from([
    ...Buffer.from('RIFF'), 0x00, 0x00, 0x00, 0x00, ...Buffer.from('WEBP'),
    ...Buffer.from('VP8X'), 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff,
    h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff,
    ...Buffer.alloc(16, 0),
  ])
}

test('imageDimensions reads width/height from file headers only (PNG/GIF/JPEG/WebP)', async () => {
  const { imageDimensions } = await import('../dist/index.js')
  assert.deepEqual(imageDimensions(pngBytes(400, 300)), { width: 400, height: 300 })
  assert.deepEqual(imageDimensions(gifBytes(320, 240)), { width: 320, height: 240 })
  assert.deepEqual(imageDimensions(jpegBytes(800, 600)), { width: 800, height: 600 })
  assert.deepEqual(imageDimensions(webpBytes(1000, 500)), { width: 1000, height: 500 })
})

test('imageDimensions returns null for non-image bytes', async () => {
  const { imageDimensions } = await import('../dist/index.js')
  assert.equal(imageDimensions(Buffer.from('hello world this is not an image at all')), null)
  assert.equal(imageDimensions(Buffer.alloc(8, 0)), null)
})

test('closestAspectRatio maps measured dimensions to the nearest supported ratio', async () => {
  const { closestAspectRatio } = await import('../dist/index.js')
  assert.equal(closestAspectRatio(1920, 1080), '16:9')
  assert.equal(closestAspectRatio(1080, 1920), '9:16')
  assert.equal(closestAspectRatio(1000, 1000), '1:1')
  assert.equal(closestAspectRatio(400, 300), '4:3')
  assert.equal(closestAspectRatio(300, 400), '3:4')
  assert.equal(closestAspectRatio(2520, 1080), '21:9')
  assert.equal(closestAspectRatio(0, 0), '1:1')
})

test('splitImageInputs supports a single source, comma-separated multi sources, and a max of 3', async () => {
  const { splitImageInputs, MAX_INPUT_IMAGES } = await import('../dist/index.js')
  assert.equal(MAX_INPUT_IMAGES, 3)
  assert.deepEqual(splitImageInputs(undefined), ['dsh-attachment:latest'])
  assert.deepEqual(splitImageInputs(''), ['dsh-attachment:latest'])
  assert.deepEqual(splitImageInputs('dsh-attachment:2'), ['dsh-attachment:2'])
  assert.deepEqual(splitImageInputs('dsh-attachment:1, dsh-attachment:2,dsh-attachment:3'), [
    'dsh-attachment:1', 'dsh-attachment:2', 'dsh-attachment:3',
  ])
  assert.deepEqual(splitImageInputs(['https://a.png', 'https://b.png']), ['https://a.png', 'https://b.png'])
  assert.throws(() => splitImageInputs('a,b,c,d'), /at most 3 input images, got 4/)
})

test('system prompt enforces the private black-box flow (no image content reading)', async () => {
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8')
  const source = await readFile(new URL('../src/host/index.ts', import.meta.url), 'utf8')
  assert.match(dist, /opaque black box/)
  assert.match(dist, /NEVER read, describe, summarize, transcribe, or analyze/)
  assert.match(dist, /verbatim as the prompt/)
  // 不再提示 Agent 去“推断图片内容”
  assert.doesNotMatch(dist, /infer the target image/)
  // aspect_ratio 说明改为自动测量（中文被 esbuild 转义，改查源码）
  assert.match(source, /自动测量第一张图片尺寸并选择最接近的比例/)
  assert.match(source, /aspect_ratio.*可选。不传时插件自动测量第一张图片尺寸并选择最接近的比例/)
})
