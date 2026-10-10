// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
}

// ================= 全局配置 =================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

// 容灾多线路源地址（GitHub + jsDelivr CDN）
const JSON_SOURCES = {
  'jin18': [
    'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
    'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/jin18.json'
  ],
  'jingjian': [
    'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
    'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/jingjian.json'
  ],
  'full': [
    'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json',
    'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/LunaTV-config.json'
  ]
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

// 获取绑定的 KV 实例（适配截图中的 KV 命名）
function getKV(env) {
  if (env && env.KV && typeof env.KV.get === 'function') return env.KV
  if (env && env.CONFIG_KV && typeof env.CONFIG_KV.get === 'function') return env.CONFIG_KV
  if (typeof globalThis.KV !== 'undefined' && globalThis.KV && typeof globalThis.KV.get === 'function') return globalThis.KV
  return null
}

// ================= Base58 算法 =================
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data)
  const bytes = new TextEncoder().encode(str)
  if (bytes.length === 0) return ''

  const digits = [0]
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let output = ''
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) output += '1'
  for (let i = digits.length - 1; i >= 0; i--) output += BASE58_ALPHABET[digits[i]]
  return output
}

// ================= LunaTV 源数据智能提取 =================
function extractSourceList(data) {
  if (!data) return []
  // 1. 核心适配：LunaTV 标准的 api_site 字典对象
  if (data.api_site && typeof data.api_site === 'object' && !Array.isArray(data.api_site)) {
    return Object.entries(data.api_site).map(([key, val]) => ({
      key: key,
      name: (val && val.name) ? val.name : key,
      api: (val && val.api) ? val.api : '',
      ...val
    }))
  }
  // 2. 兼容数组格式
  if (Array.isArray(data)) return data
  for (const k of ['sites', 'video', 'sources', 'list']) {
    if (Array.isArray(data[k])) return data[k]
  }
  return []
}

// ================= 过滤禁用源（拉取时不传给播放器） =================
function filterDisabled(data, disabledKeys = []) {
  if (!disabledKeys || disabledKeys.length === 0) return data
  const disabledSet = new Set(disabledKeys.map(String))

  // 针对 api_site 对象，直接从输出中剔除禁用的 key
  if (data && data.api_site && typeof data.api_site === 'object' && !Array.isArray(data.api_site)) {
    const copy = JSON.parse(JSON.stringify(data))
    for (const [key, val] of Object.entries(copy.api_site)) {
      const k = String(key)
      const name = val && val.name ? String(val.name) : ''
      const api = val && val.api ? String(val.api) : ''
      if (disabledSet.has(k) || disabledSet.has(name) || disabledSet.has(api)) {
        delete copy.api_site[key]
      }
    }
    return copy
  }

  // 针对数组格式
  if (Array.isArray(data)) {
    const res = data.filter(item => {
      const k = String(item.key || item.name || item.api)
      return !disabledSet.has(k) && !disabledSet.has(item.name) && !disabledSet.has(item.api)
    })
    return res.length > 0 ? res : data
  }

  return data
}

// 递归替换 API 代理前缀
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))

  const newObj = {}
  for (const key of Object.keys(obj)) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      if (apiUrl.includes('?url=')) apiUrl = apiUrl.slice(apiUrl.indexOf('?url=') + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// 拉取源配置
async function fetchConfig(sourceKey, env, forceRefresh = false) {
  const kv = getKV(env)
  const cacheKey = 'CONFIG_CACHE_' + sourceKey

  if (kv && !forceRefresh) {
    try {
      const cached = await kv.get(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (extractSourceList(parsed).length > 0) return parsed
      }
    } catch {}
  }

  const urls = JSON_SOURCES[sourceKey] || JSON_SOURCES['jingjian']
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
      })
      if (res.ok) {
        const data = await res.json()
        if (data && extractSourceList(data).length > 0) {
          if (kv) await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 }).catch(() => {})
          return data
        }
      }
    } catch {}
  }
  throw new Error('无法连接配置源，请稍后重试')
}

// ================= 主请求路由 =================
async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const currentOrigin = reqUrl.origin
  const defaultPrefix = `${currentOrigin}/?url=`

  // 1. 通用 API 反代转发
  if (reqUrl.searchParams.has('url') || request.url.includes('?url=')) {
    return handleProxyRequest(request, currentOrigin)
  }

  // 2. 异步拉取源接口
  if (reqUrl.pathname === '/api/manage/sources') {
    const sourceKey = reqUrl.searchParams.get('source') || 'jingjian'
    const force = reqUrl.searchParams.get('refresh') === '1'
    try {
      const rawData = await fetchConfig(sourceKey, env, force)
      const list = extractSourceList(rawData)
      const kv = getKV(env)
      let disabledList = []
      if (kv) {
        const stored = await kv.get(`DISABLED_${sourceKey}`)
        if (stored) {
          try { disabledList = JSON.parse(stored) } catch {}
        }
      }
      return jsonResponse({ list, disabled: disabledList })
    } catch (e) {
      return jsonResponse({ error: e.message }, 500)
    }
  }

  // 3. 保存禁用源列表到 KV
  if (reqUrl.pathname === '/api/manage/save-disabled' && request.method === 'POST') {
    const kv = getKV(env)
    if (!kv) return jsonResponse({ error: '未检测到绑定的 KV 空间，请检查设置并重新部署' }, 400)
    try {
      const body = await request.json()
      const { source, disabled } = body
      await kv.put(`DISABLED_${source || 'jingjian'}`, JSON.stringify(disabled || []))
      return jsonResponse({ success: true })
    } catch (e) {
      return jsonResponse({ error: e.message }, 500)
    }
  }

  // 4. 重置全部源（解除禁用）
  if (reqUrl.pathname === '/api/manage/reset' && request.method === 'POST') {
    const kv = getKV(env)
    if (kv) {
      const body = await request.json()
      const source = body.source || 'jingjian'
      await kv.delete(`DISABLED_${source}`)
      await kv.delete('CONFIG_CACHE_' + source)
    }
    return jsonResponse({ success: true })
  }

  // 5. 播放器订阅拉取（自动剔除禁用源）
  if (reqUrl.searchParams.has('format')) {
    const formatParam = reqUrl.searchParams.get('format')
    const sourceParam = reqUrl.searchParams.get('source') || 'full'
    const prefixParam = reqUrl.searchParams.get('prefix')
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 6. 首页展示（图 2 原版设计）
  return handleHomePage(currentOrigin, env)
}

// ================= API 反代核心 =================
async function handleProxyRequest(request, currentOrigin) {
  const marker = '?url='
  const markerIdx = request.url.indexOf(marker)
  let rawTarget = request.url.slice(markerIdx + marker.length).trim()
  try { rawTarget = decodeURIComponent(rawTarget) } catch {}

  // 自动修复播放器参数拼接中缺失的 '?'
  const schemeIdx = rawTarget.indexOf('://')
  if (schemeIdx !== -1) {
    const pathAndQuery = rawTarget.slice(schemeIdx + 3)
    if (!pathAndQuery.includes('?') && pathAndQuery.includes('&')) {
      const firstAmp = rawTarget.indexOf('&', schemeIdx + 3)
      rawTarget = rawTarget.slice(0, firstAmp) + '?' + rawTarget.slice(firstAmp + 1)
    }
  }

  let targetURL
  try { targetURL = new URL(rawTarget) } catch {
    return jsonResponse({ error: 'Invalid Target URL', target: rawTarget }, 400)
  }

  try {
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete('host')
    forwardedHeaders.delete('referer')
    forwardedHeaders.delete('origin')
    forwardedHeaders.delete('cf-connecting-ip')
    forwardedHeaders.delete('cf-ray')
    forwardedHeaders.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36')
    forwardedHeaders.set('accept', '*/*')

    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
      redirect: 'follow'
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch
