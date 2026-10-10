import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const columns = ['用例编号', '所属模块', '用例标题', '前置条件', '测试数据', '操作步骤', '预期结果', '优先级', '自动化状态', '对应测试']

function parseCsv(source) {
  const records = []
  let record = []
  let field = ''
  let quoted = false
  const input = source.replace(/^\uFEFF/, '')
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') {
      if (field) throw new Error('CSV 引号只能出现在字段开头。')
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n') {
      record.push(field)
      if (record.some(Boolean)) records.push(record)
      record = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合。')
  if (field || record.length) {
    record.push(field)
    if (record.some(Boolean)) records.push(record)
  }
  return records
}

function keyFor(file, name) {
  return `${file} :: ${name}`
}

async function main() {
  const records = parseCsv(await readFile(path.join(root, 'test/test_cases.csv'), 'utf8'))
  if (!records.length || records[0].join(',') !== columns.join(',')) throw new Error('test_cases.csv 列名与标准格式不符。')

  const testFiles = (await readdir(path.join(root, 'test'))).filter((name) => name.endsWith('.test.mjs')).map((name) => `test/${name}`)
  if (!testFiles.length) throw new Error('没有找到测试文件。')
  const cases = []
  const ids = new Set()
  const mappedTests = new Set()
  for (const [index, record] of records.slice(1).entries()) {
    if (record.length !== columns.length) throw new Error(`CSV 第 ${index + 2} 行列数不正确。`)
    const item = Object.fromEntries(columns.map((column, columnIndex) => [column, record[columnIndex].trim()]))
    const id = item['用例编号']
    if (!id || ids.has(id)) throw new Error(`CSV 第 ${index + 2} 行用例编号为空或重复：${id}`)
    ids.add(id)
    if (!item['用例标题'] || !item['预期结果']) throw new Error(`${id} 缺少标题或预期结果。`)
    if (!['已自动化', '待自动化'].includes(item['自动化状态'])) throw new Error(`${id} 的自动化状态无效。`)
    const mappings = item['对应测试'] ? item['对应测试'].split(' | ').map((entry) => {
      const separator = entry.indexOf(' :: ')
      if (separator < 0) throw new Error(`${id} 的测试映射格式无效：${entry}`)
      const file = entry.slice(0, separator)
      const name = entry.slice(separator + 4)
      if (!testFiles.includes(file) || !name) throw new Error(`${id} 指向不存在的测试文件或空测试名：${entry}`)
      const key = keyFor(file, name)
      mappedTests.add(key)
      return key
    }) : []
    if (item['自动化状态'] === '已自动化' && !mappings.length) throw new Error(`${id} 标为已自动化但没有对应测试。`)
    cases.push({ id, status: item['自动化状态'], mappings })
  }
  if (!cases.length) throw new Error('用例清单为空。')

  const observed = new Map()
  let suiteSuccess = false
  for await (const event of run({ files: testFiles.map((file) => path.join(root, file)) })) {
    if (event.type === 'test:summary' && !event.data.file) suiteSuccess = event.data.success
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    if (event.data.details?.type !== 'test') continue
    const file = path.relative(root, event.data.file).split(path.sep).join('/')
    observed.set(keyFor(file, event.data.name), {
      result: event.type === 'test:fail' ? 'failed' : event.data.skip || event.data.todo ? 'incomplete' : 'passed',
      reason: event.data.details?.error?.message || (event.data.skip ? 'skipped' : event.data.todo ? 'TODO' : ''),
    })
  }

  let passed = 0
  const failed = []
  const incomplete = []
  for (const item of cases) {
    if (item.status === '待自动化') { incomplete.push(`${item.id}：待自动化`); continue }
    const results = item.mappings.map((mapping) => ({ mapping, ...observed.get(mapping) }))
    const failure = results.find((entry) => entry.result === 'failed')
    const missing = results.find((entry) => !entry.result || entry.result === 'incomplete')
    if (failure) failed.push(`${item.id}：${failure.mapping}（${failure.reason || '失败'}）`)
    else if (missing) incomplete.push(`${item.id}：${missing.mapping}（${missing.reason || '未执行'}）`)
    else passed += 1
  }
  const unmapped = [...observed.keys()].filter((key) => !mappedTests.has(key))
  console.log(`${passed}/${cases.length} cases passed; ${failed.length} failed; ${incomplete.length} incomplete`)
  for (const entry of failed) console.error(`失败 ${entry}`)
  for (const entry of incomplete) console.error(`未完成 ${entry}`)
  for (const entry of unmapped) console.error(`未映射 ${entry}`)
  if (!suiteSuccess && !failed.length) console.error('测试进程失败；请检查测试文件加载或运行错误。')
  if (!suiteSuccess || failed.length || incomplete.length || unmapped.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(`功能回归无法运行：${error.message}`)
  process.exitCode = 1
})
