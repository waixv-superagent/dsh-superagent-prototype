#!/usr/bin/env node
// Swarm 流水线跟进（p4 后端的最小可用版本）。
//
// 用法：
//   node scripts/swarm-followup.mjs <reviewId>            # 轮询到有结论（默认 60s 一次）
//   node scripts/swarm-followup.mjs <reviewId> --once     # 只查一次
//   node scripts/swarm-followup.mjs <reviewId> --interval 120
//   node scripts/swarm-followup.mjs --self-test           # 用内置样本自检解析逻辑
//
// 凭据只从环境变量读，不写入任何文件、不出现在命令行：
//   P4USER    p4 用户名
//   P4TICKET  p4 ticket（来自 `p4 tickets`，与 Swarm 的 HTTP Basic 认证共用）
// 可选：
//   DSH_SUPERAGENT_SWARM_URL  默认 https://swarm.example.com
//   DSH_SUPERAGENT_SWARM_API  默认 /api/v10
//
// 退出码：0 全部通过 / 1 有失败 / 2 仍在跑（--once 时）/ 3 配置或网络错误
//
// 接口形状来自项目内的 pipeline-followup skill（实际调用过），不是按记忆猜的：GET {base}{api}/reviews/<id>/testruns 返回
//   { "data": { "testruns": [ { "id", "test", "status", "url", "title" } ] } }
// status 取 pass | fail | running。

const DEFAULT_BASE = 'https://swarm.example.com'
const DEFAULT_API = '/api/v10'

/** 把 testruns 响应归一成一份结论；无法识别形状时抛出可读错误而不是静默当作通过。 */
export function summarizeTestruns (payload) {
  const runs = payload?.data?.testruns
  if (!Array.isArray(runs)) throw new Error('unexpected payload: data.testruns is not an array')
  const groups = { pass: [], fail: [], running: [], other: [] }
  for (const run of runs) {
    const bucket = groups[run?.status] ?? groups.other
    bucket.push({
      title: String(run?.title ?? '(untitled)'),
      status: String(run?.status ?? '(unknown)'),
      url: run?.url ? String(run.url) : null,
      id: run?.id ?? null
    })
  }
  const verdict = groups.fail.length > 0 ? 'fail' : groups.running.length > 0 || groups.other.length > 0 ? 'running' : 'pass'
  return {
    verdict,
    total: runs.length,
    pass: groups.pass.length,
    fail: groups.fail.length,
    running: groups.running.length + groups.other.length,
    failures: groups.fail,
    pending: [...groups.running, ...groups.other]
  }
}

// AI review 的结论在 comments 里，不在 testruns 的 messages 中（后者只有「AI Code Review 成功」这类流水线状态）。
// comments 报文里每条评论的正文段落是 commit 关联度评分、TAPD 提交范围评分、审核结论三块，
// 但字段名没有一份可靠样本，所以这里不按字段名取值：递归收集报文中所有字符串，取最后一条含「审核结论」的作为结论。
// 这样字段改名不会静默失效；找不到就返回 null，由调用方提示「读不到结论」，而不是当成通过。
const VERDICT_MARKER = '审核结论'

function collectStrings (node, into = []) {
  if (typeof node === 'string') into.push(node)
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, into)
  else if (node && typeof node === 'object') for (const value of Object.values(node)) collectStrings(value, into)
  return into
}

/** 从 comments 报文里抽出审核结论；读不到返回 null（不当作通过）。 */
export function summarizeComments (payload) {
  if (!payload || typeof payload !== 'object') throw new Error('unexpected payload: not an object')
  if (payload.error) throw new Error(`Swarm returned an error: ${JSON.stringify(payload.error)}`)
  const strings = collectStrings(payload.data ?? payload)
  const verdicts = strings.filter((text) => text.includes(VERDICT_MARKER))
  const verdict = verdicts.length > 0 ? verdicts[verdicts.length - 1].trim() : null
  return {
    commentCount: Array.isArray(payload.data?.comments) ? payload.data.comments.length : null,
    verdict,
    // 结论里出现「建议」通常意味着还有返工项；出现「通过」意味着可以收尾。两者都可能同时出现，交给调用方展示原文。
    advice: verdict ? /建议/.test(verdict) : false,
    approved: verdict ? /通过/.test(verdict) : false
  }
}

/** 拉取一次 comments。 */
export async function fetchComments ({ base = DEFAULT_BASE, api = DEFAULT_API, reviewId, user, ticket, fetchImpl = fetch }) {
  if (!reviewId) throw new Error('a review id is required')
  if (!user || !ticket) throw new Error('P4USER and P4TICKET must be set in the environment')
  const url = `${base}${api}/reviews/${encodeURIComponent(reviewId)}/comments`
  const response = await fetchImpl(url, {
    headers: { authorization: `Basic ${Buffer.from(`${user}:${ticket}`).toString('base64')}` }
  })
  if (response.status === 401 || response.status === 403) throw new Error(`Swarm rejected the credentials (HTTP ${response.status})`)
  if (!response.ok) throw new Error(`Swarm returned HTTP ${response.status} for ${url}`)
  return summarizeComments(await response.json())
}

/** 拉取一次 testruns。`fetchImpl` 只为自检注入，生产走全局 fetch。 */export async function fetchTestruns ({ base = DEFAULT_BASE, api = DEFAULT_API, reviewId, user, ticket, fetchImpl = fetch }) {
  if (!reviewId) throw new Error('a review id is required')
  if (!user || !ticket) throw new Error('P4USER and P4TICKET must be set in the environment')
  const url = `${base}${api}/reviews/${encodeURIComponent(reviewId)}/testruns`
  const response = await fetchImpl(url, {
    headers: { authorization: `Basic ${Buffer.from(`${user}:${ticket}`).toString('base64')}` }
  })
  if (response.status === 401 || response.status === 403) throw new Error(`Swarm rejected the credentials (HTTP ${response.status})`)
  if (!response.ok) throw new Error(`Swarm returned HTTP ${response.status} for ${url}`)
  return summarizeTestruns(await response.json())
}

/** 打印一份人能直接读的结论。 */
export function report (summary, reviewId) {
  const lines = [
    `review ${reviewId}: ${summary.verdict} — pass ${summary.pass}, fail ${summary.fail}, running ${summary.running} (total ${summary.total})`
  ]
  for (const failure of summary.failures) lines.push(`  FAILED  ${failure.title}${failure.url ? ` → ${failure.url}` : ''}`)
  for (const item of summary.pending) lines.push(`  PENDING ${item.title} (${item.status})`)
  return lines.join('\n')
}

const SELF_TEST_PAYLOAD = {
  data: {
    testruns: [
      { id: 286020, test: 2, status: 'pass', url: 'https://ci.example.com/blue/organizations/jenkins/PreApproval-ClangTidy/detail/PreApproval-ClangTidy/22610/pipeline', title: 'PreApproval-ClangTidy' },
      { id: 286021, test: 3, status: 'fail', url: 'https://ci.example.com/blue/organizations/jenkins/Entry/detail/Entry/9001/pipeline', title: 'Entry' },
      { id: 286022, test: 3, status: 'running', url: null, title: 'PreApproval-Build' }
    ]
  }
}

async function selfTest () {
  const summary = summarizeTestruns(SELF_TEST_PAYLOAD)
  const problems = []
  if (summary.verdict !== 'fail') problems.push(`verdict should be fail, got ${summary.verdict}`)
  if (summary.pass !== 1 || summary.fail !== 1 || summary.running !== 1) problems.push(`counts wrong: ${JSON.stringify(summary)}`)
  if (summary.failures[0]?.title !== 'Entry') problems.push('the failing check should be Entry')
  // 认证头必须带 Basic 且来自环境变量，而不是写在命令行
  let seen = null
  await fetchTestruns({
    reviewId: '12345', user: 'u', ticket: 't',
    fetchImpl: async (url, init) => {
      seen = { url, authorization: init?.headers?.authorization }
      return { ok: true, status: 200, json: async () => SELF_TEST_PAYLOAD }
    }
  })
  if (seen?.url !== `${DEFAULT_BASE}${DEFAULT_API}/reviews/12345/testruns`) problems.push(`unexpected url ${seen?.url}`)
  if (seen?.authorization !== `Basic ${Buffer.from('u:t').toString('base64')}`) problems.push('missing basic auth header')
  await fetchTestruns({
    reviewId: '12345', user: 'u', ticket: 't',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
  }).then(() => problems.push('a 401 should have thrown')).catch(error => {
    if (!/rejected the credentials/.test(error.message)) problems.push(`401 message was ${error.message}`)
  })
  if (problems.length > 0) {
    console.error(`self-test FAILED:\n- ${problems.join('\n- ')}`)
    return 1
  }
  // comments：字段名不可靠，靠「审核结论」标记递归定位，取最后一条。
  const commentsPayload = {
    error: null,
    messages: [],
    data: {
      comments: [
        { id: 1, topic: 'AI Code Review', body: 'commit 关联度评分：8/10\nTAPD 提交范围评分：6/10\n审核结论：建议\n- 补一句为什么这样改' },
        { id: 2, topic: 'AI Code Review', body: 'commit 关联度评分：9/10\nTAPD 提交范围评分：9/10\n审核结论：通过' }
      ]
    }
  }
  const comments = summarizeComments(commentsPayload)
  if (comments.commentCount !== 2) problems.push(`commentCount should be 2, got ${comments.commentCount}`)
  if (!comments.verdict?.includes('通过')) problems.push(`the last verdict should be 通过, got ${comments.verdict}`)
  if (comments.advice) problems.push('the last verdict should not carry advice')
  if (!comments.approved) problems.push('approved should be true')
  const blockedComments = summarizeComments({ error: null, data: { comments: [{ id: 3, body: '（没有结论段）' }] } })
  if (blockedComments.verdict !== null) problems.push('a payload without a verdict must yield null, not an approval')
  if (problems.length > 0) {
    console.error(`self-test FAILED:\n- ${problems.join('\n- ')}`)
    return 1
  }
  console.log(report(summary, '12345'))
  console.log(`comments: ${comments.commentCount} 条，结论「${comments.verdict}」`)
  console.log('self-test passed')
  return 0
}

async function main (argv) {
  if (argv.includes('--self-test')) return selfTest()
  const option = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const reviewId = argv.find(arg => !arg.startsWith('--') && !Number.isNaN(Number(arg)) && arg !== option('--interval'))
  if (!reviewId) {
    console.error('usage: node scripts/swarm-followup.mjs <reviewId> [--once] [--interval 60] [--comments] [--comments-only] [--self-test]')
    return 3
  }
  const base = process.env.DSH_SUPERAGENT_SWARM_URL || DEFAULT_BASE
  const api = process.env.DSH_SUPERAGENT_SWARM_API || DEFAULT_API
  const once = argv.includes('--once')
  const commentsOnly = argv.includes('--comments-only')
  const withComments = argv.includes('--comments') || commentsOnly
  const interval = Number(option('--interval', '60')) * 1000
  const credentials = () => ({ base, api, reviewId, user: process.env.P4USER, ticket: process.env.P4TICKET })
  if (withComments) {
    // AI review 的结论在 comments 里，先看它，省掉等流水线的几十分钟。
    try {
      const comments = await fetchComments(credentials())
      console.log(`review ${reviewId}: AI review ${comments.approved ? '通过' : comments.advice ? '建议' : '结论不明'}（${comments.commentCount ?? '?'} 条评论）`)
      if (comments.verdict) console.log(comments.verdict)
      else console.log('（读不到「审核结论」段，需人工看 review 页面）')
    } catch (error) {
      console.error(String(error.message ?? error))
      return 3
    }
    if (commentsOnly) return 0
  }
  // 轮询到有结论为止；失败即停，交给人或 worker 去 reshelve。
  for (;;) {
    try {
      const summary = await fetchTestruns(credentials())
      console.log(report(summary, reviewId))
      if (summary.verdict === 'pass') return 0
      if (summary.verdict === 'fail') return 1
      if (once) return 2
    } catch (error) {
      console.error(String(error.message ?? error))
      return 3
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('swarm-followup.mjs')) {
  process.exit(await main(process.argv.slice(2)))
}

