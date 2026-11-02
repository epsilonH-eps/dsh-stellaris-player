/**
 * 群星链接器（connector）的 HTTP 客户端。
 *
 * connector 默认在 127.0.0.1:8790，提供 /api/status、/api/snapshot、/api/actions、/api/commands。
 * 这个文件只负责「发请求 + 收 JSON + 把错误说成人话」，方便工具层直接调用。
 */

export function baseUrl() {
  const raw = process.env.STELLARIS_CONNECTOR_URL || 'http://127.0.0.1:8790'
  return String(raw).replace(/\/+$/, '')
}

async function request(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const url = baseUrl() + path
  let response
  try {
    response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const detail = String(error?.message || error)
    throw new Error(
      `连不上群星链接器（${url}）：${detail}。先启动「群星链接器」并让游戏进到存档里。`,
    )
  }

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    const reason = data?.error || data?.detail || `HTTP ${response.status}`
    throw new Error(`链接器返回 ${response.status}：${reason}`)
  }
  return data
}

export async function readStatus() {
  return request('/api/status', { timeoutMs: 8000 })
}

export async function readState({ deep = false } = {}) {
  const data = await request(`/api/snapshot?view=compact&deep=${deep ? 1 : 0}`, {
    timeoutMs: deep ? 60000 : 20000,
  })
  return data?.snapshot ?? data
}

export async function readActions({ unit = '' } = {}) {
  const query = unit ? `?unit=${encodeURIComponent(unit)}` : ''
  return request(`/api/actions${query}`, { timeoutMs: 10000 })
}

export async function executeActions({ actions, wait = true, idempotencyKey = '' } = {}) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) throw new Error('actions 不能为空：至少给一条 { method, params }')
  if (list.length > 32) throw new Error('一次最多 32 条动作')
  const payload = {
    source: 'dsh-stellaris-player',
    wait: wait !== false,
    actions: list.map((row) => ({ method: row?.method, params: row?.params ?? {} })),
  }
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey
  return request('/api/commands', { method: 'POST', body: payload, timeoutMs: wait === false ? 15000 : 120000 })
}
