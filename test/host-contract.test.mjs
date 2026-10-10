import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const hostPackagePath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
const hostClientPath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/client')
const desktopAsarPath = process.env.TOKENSCOWORK_APP_ASAR
  ?? '/Applications/TokensCowork.app/Contents/Resources/app.asar'

async function readAsarEntry(archivePath, entryPath) {
  const archive = await open(archivePath, 'r')
  try {
    const prefix = Buffer.alloc(16)
    await archive.read(prefix, 0, prefix.length, 0)
    const headerLength = prefix.readUInt32LE(12)
    const header = Buffer.alloc(headerLength)
    await archive.read(header, 0, header.length, 16)
    let entry = JSON.parse(header.toString('utf8').replace(/\0+$/, ''))
    for (const segment of entryPath.split('/')) entry = entry.files?.[segment]
    assert.ok(entry && !entry.unpacked, `桌面安装包缺少 ${entryPath}`)
    const data = Buffer.alloc(entry.size)
    const dataOffset = 8 + prefix.readUInt32LE(4)
    await archive.read(data, 0, data.length, dataOffset + Number(entry.offset))
    return data
  } finally {
    await archive.close()
  }
}

function composerSlotCalls(source) {
  const tree = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const calls = new Map()
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'renderSlot'
      && ts.isStringLiteral(node.arguments[0])) {
      calls.set(node.arguments[0].text, node.arguments[1])
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return calls
}

test('host composer exposes the attachment intake and prompt control slots', async () => {
  const hostSource = await readFile(hostClientPath, 'utf8')
  const calls = composerSlotCalls(hostSource)
  const attachments = calls.get('conversation.input.attachments')
  assert.ok(attachments && ts.isObjectLiteralExpression(attachments))
  const props = new Map(attachments.properties
    .filter((property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    .map((property) => [property.name.getText(), ts.isPropertyAssignment(property) ? property.initializer : property.name]))
  assert.ok(ts.isIdentifier(props.get('onAddFiles')))
  assert.equal(props.get('onAddFiles').text, 'intakeFiles')
  assert.ok(ts.isArrowFunction(props.get('onRemoveAttachment')))
  assert.ok(props.has('canAcceptDrop'))
  assert.ok(props.has('attachments'))
  assert.ok(calls.has('conversation.input.left'))

  let desktopPackage
  try {
    desktopPackage = JSON.parse((await readAsarEntry(
      desktopAsarPath,
      'node_modules/@deepseek-ai/dsh-client-ui-conversation/package.json',
    )).toString('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && !process.env.TOKENSCOWORK_APP_ASAR) return
    throw error
  }
  const localPackage = JSON.parse(await readFile(hostPackagePath, 'utf8'))
  assert.equal(desktopPackage.name, localPackage.name)
  const desktopClient = await readAsarEntry(
    desktopAsarPath,
    'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
  )
  assert.deepEqual(desktopClient, Buffer.from(hostSource),
    `TokensCowork 内置的宿主 ${desktopPackage.version} 与本地测试包 ${localPackage.version} 实现不同`)
})
