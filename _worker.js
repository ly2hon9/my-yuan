// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
}

// ================= 常量配置 =================
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

// 智能捕获 KV 绑定
function getKV(env) {
  if (env) {
    if (env.KV && typeof env.KV.get === 'function') return env.KV
    if (env.LUNATV_KV && typeof env.LUNATV_KV.get === 'function') return env.LUNATV_KV
    if (env.CONFIG_KV && typeof env.CONFIG_KV.get === 'function') return env.CONFIG_KV
    for (const k of Object.keys(env)) {
      if (env[k] && typeof env[k].get === 'function' && typeof env[k].put === 'function') {
        return env[k]
      }
    }
  }
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

// ================= 源列表智能解析 =================
function extractSourceList(data) {
  if (!data) return []
  let list = []
  if (data.api_site && typeof data.api_site === 'object' && !Array.isArray(data.api_site)) {
    list = Object.entries(data.api_site).map(([key, val]) => ({
      key: key,
      name: (val && val.name) ? String(val.name).trim() : key,
      api: (val && val.api) ? String(val.api).trim() : '',
      ...(typeof val === 'object' ? val : {})
    }))
  } else {
    for (const k of ['sites', 'video', 'sources', 'list']) {
      if (Array.isArray(data[k])) { list = data[k]; break; }
    }
    if (list.length === 0 && Array.isArray(data)) list = data
  }

  return list.map((item, idx) => {
    const obj = typeof item === 'object' && item !== null ? { ...item } : { name: String(item), api: '' }
    obj.id = String(obj.key || obj.api || obj.name || ('source_' + idx)).trim()
    return obj
  })
}

// ================= 严格过滤已禁用源 =================
function filterDisabled(data, disabledList = []) {
  if (!disabledList || disabledList.length === 0) return data
  const disabledSet = new Set(disabledList.map(s => String(s).trim().toLowerCase()))

  const shouldRemove = (val, dictKey = '') => {
    if (dictKey && disabledSet.has(String(dictKey).trim().toLowerCase())) return true
    if (val && typeof val === 'object' && val !== null) {
      if (val.key && disabledSet.has(String(val.key).trim().toLowerCase())) return true
      if (val.name && disabledSet.has(String(val.name).trim().toLowerCase())) return true
      if (val.api && disabledSet.has(String(val.api).trim().toLowerCase())) return true
      if (val.id && disabledSet.has(String(val.id).trim().toLowerCase())) return true
    } else if (typeof val === 'string') {
      if (disabledSet.has(val.trim().toLowerCase())) return true
    }
    return false
  }

  const copy = JSON.parse(JSON.stringify(data))
  if (copy.api_site && typeof copy.api_site === 'object' && !Array.isArray(copy.api_site)) {
    for (const [k, v] of Object.entries(copy.api_site)) {
      if (shouldRemove(v, k)) delete copy.api_site[k]
    }
    return copy
  }
  if (Array.isArray(copy)) {
    return copy.filter(item => !shouldRemove(item))
  }
  for (const listKey of ['sites', 'video', 'sources', 'list']) {
    if (Array.isArray(copy[listKey])) {
      copy[listKey] = copy[listKey].filter(item => !shouldRemove(item))
    }
  }
  return copy
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
  throw new Error('无法连接配置源，请检查网络')
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

  // 2. 异步接口：获取源列表、禁用状态及历史测速缓存
  if (reqUrl.pathname === '/api/manage/sources') {
    const sourceKey = reqUrl.searchParams.get('source') || 'jingjian'
    const force = reqUrl.searchParams.get('refresh') === '1'
    try {
      const rawData = await fetchConfig(sourceKey, env, force)
      const list = extractSourceList(rawData)
      const kv = getKV(env)
      let disabledList = []
      let testResults = {}
      if (kv) {
        const stored = await kv.get(`DISABLED_${sourceKey}`)
        const globalStored = await kv.get('DISABLED_GLOBAL')
        const s1 = stored ? JSON.parse(stored) : []
        const s2 = globalStored ? JSON.parse(globalStored) : []
        disabledList = Array.from(new Set([...s1, ...s2]))

        const tStored = await kv.get(`TEST_RESULTS_${sourceKey}`)
        if (tStored) testResults = JSON.parse(tStored)
      }
      return jsonResponse({ list, disabled: disabledList, testResults })
    } catch (e) {
      return jsonResponse({ error: e.message }, 500)
    }
  }

  // 3. 保存禁用列表和测速状态到 KV
  if (reqUrl.pathname === '/api/manage/save-disabled' && request.method === 'POST') {
    const kv = getKV(env)
    if (!kv) return jsonResponse({ error: '未检测到绑定的 KV 空间' }, 400)
    try {
      const body = await request.json()
      const { source, disabled, testResults } = body
      const sourceKey = source || 'jingjian'
      const disabledArray = Array.isArray(disabled) ? disabled : []

      await kv.put(`DISABLED_${sourceKey}`, JSON.stringify(disabledArray))
      if (testResults && typeof testResults === 'object') {
        await kv.put(`TEST_RESULTS_${sourceKey}`, JSON.stringify(testResults))
      }

      let globalList = []
      try {
        const g = await kv.get('DISABLED_GLOBAL')
        if (g) globalList = JSON.parse(g)
      } catch {}
      const mergedGlobal = Array.from(new Set([...globalList, ...disabledArray]))
      await kv.put('DISABLED_GLOBAL', JSON.stringify(mergedGlobal))

      await kv.delete(`CONFIG_CACHE_${sourceKey}`).catch(() => {})
      return jsonResponse({ success: true, count: disabledArray.length })
    } catch (e) {
      return jsonResponse({ error: e.message }, 500)
    }
  }

  // 4. 重置全部源
  if (reqUrl.pathname === '/api/manage/reset' && request.method === 'POST') {
    const kv = getKV(env)
    if (kv) {
      const body = await request.json()
      const source = body.source || 'jingjian'
      await kv.delete(`DISABLED_${source}`)
      await kv.delete(`TEST_RESULTS_${source}`)
      await kv.delete('DISABLED_GLOBAL')
      await kv.delete('CONFIG_CACHE_' + source)
    }
    return jsonResponse({ success: true })
  }

  // 5. 播放器订阅拉取
  if (reqUrl.searchParams.has('format')) {
    const formatParam = reqUrl.searchParams.get('format')
    const sourceParam = reqUrl.searchParams.get('source') || 'full'
    const prefixParam = reqUrl.searchParams.get('prefix')
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 6. 首页展示
  return handleHomePage(currentOrigin, defaultPrefix, env)
}

// ================= API 反代核心 =================
async function handleProxyRequest(request, currentOrigin) {
  const marker = '?url='
  const markerIdx = request.url.indexOf(marker)
  let rawTarget = request.url.slice(markerIdx + marker.length).trim()
  try { rawTarget = decodeURIComponent(rawTarget) } catch {}

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
  } catch (err) {
    return jsonResponse({ error: 'Proxy Error', message: err.message }, 502)
  }
}

// ================= 生成订阅处理 =================
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) return jsonResponse({ error: 'Invalid format parameter' }, 400)

    let data = await fetchConfig(sourceParam, env)

    const kv = getKV(env)
    let disabledKeys = []
    if (kv) {
      try {
        const stored = await kv.get(`DISABLED_${sourceParam}`)
        const globalStored = await kv.get('DISABLED_GLOBAL')
        const s1 = stored ? JSON.parse(stored) : []
        const s2 = globalStored ? JSON.parse(globalStored) : []
        disabledKeys = Array.from(new Set([...s1, ...s2]))
      } catch {}
    }

    data = filterDisabled(data, disabledKeys)
    const finalData = config.proxy ? addOrReplacePrefix(data, prefixParam || defaultPrefix) : data

    const noCacheHeaders = {
      ...CORS_HEADERS,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'CDN-Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store'
    }

    if (config.base58) {
      return new Response(base58Encode(finalData), {
        headers: { 'Content-Type': 'text/plain; charset=UTF-8', ...noCacheHeaders },
      })
    } else {
      return new Response(JSON.stringify(finalData), {
        headers: { 'Content-Type': 'application/json; charset=UTF-8', ...noCacheHeaders },
      })
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500)
  }
}

// ================= 前端页面 UI =================
async function handleHomePage(origin, defaultPrefix, env) {
  let initialList = []
  let initialDisabled = []
  let initialTestResults = {}
  try {
    const raw = await fetchConfig('jingjian', env)
    initialList = extractSourceList(raw)
    const kv = getKV(env)
    if (kv) {
      const stored = await kv.get('DISABLED_jingjian')
      const gStored = await kv.get('DISABLED_GLOBAL')
      const s1 = stored ? JSON.parse(stored) : []
      const s2 = gStored ? JSON.parse(gStored) : []
      initialDisabled = Array.from(new Set([...s1, ...s2]))

      const tStored = await kv.get('TEST_RESULTS_jingjian')
      if (tStored) initialTestResults = JSON.parse(tStored)
    }
  } catch {}

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CORSAPI（API 代理 & JSON 订阅器）</title>
  <style>
    :root {
      --bg: #121417;
      --card-bg: #1c2026;
      --border: #2a303c;
      --text: #e2e8f0;
      --text-muted: #8c9ba5;
      --primary: #1da1f2;
      --danger: #e0245e;
      --warning: #ffad1f;
      --success: #17bf63;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 25px auto; padding: 0 14px; background: var(--bg); color: var(--text); line-height: 1.5; }
    h1 { font-size: 20px; color: #fff; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
    h2 { font-size: 17px; color: #fff; margin: 24px 0 10px; display: flex; align-items: center; gap: 6px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
    .card-title { font-weight: bold; margin-bottom: 10px; font-size: 14px; color: #fff; }

    pre { background: #15181e; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); font-size: 13px; overflow-x: auto; margin: 0; word-break: break-all; }
    .link-row { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; background: #15181e; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); gap: 8px; }
    .link-content { font-size: 13px; color: #cbd5e1; word-break: break-all; }
    code { font-family: monospace; color: var(--warning); background: rgba(255, 173, 31, 0.1); padding: 2px 5px; border-radius: 4px; font-size: 12.5px; }
    .btn-copy { background: #0070f3; color: #fff; border: none; padding: 5px 12px; border-radius: 5px; font-size: 12px; cursor: pointer; flex-shrink: 0; }
    .btn-copy:hover { opacity: 0.88; }

    .config-tabs-container { margin-bottom: 14px; }
    .config-tabs-label { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; display: block; }
    .config-tabs-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .config-tab-btn {
      background: #15181e;
      color: #94a3b8;
      border: 1px solid var(--border);
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .config-tab-btn:hover { color: #fff; border-color: #475569; }
    .config-tab-btn.active {
      background: #0070f3;
      color: #fff;
      border-color: #0070f3;
      font-weight: 500;
    }

    .btn-group { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .btn-action { border: none; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; color: #fff; }
    .btn-blue { background: #0070f3; }
    .btn-orange { background: var(--warning); color: #000; font-weight: bold; }
    .btn-green { background: var(--success); }
    .btn-action:disabled { opacity: 0.5; cursor: not-allowed; }

    .stats-bar { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; padding: 2px 0; }
    .stats-bar span { font-weight: bold; color: #fff; margin: 0 3px; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid var(--border); padding: 10px 8px; text-align: left; }
    th { background: #161a20; color: #94a3b8; font-weight: 500; }
    tr:nth-child(even) { background: #16191f; }
    tr.is-disabled { opacity: 0.55; background: rgba(0, 0, 0, 0.2); }
    .badge { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
    a.link-btn { color: var(--primary); text-decoration: none; }
    a.link-btn:hover { text-decoration: underline; }

    .switch { position: relative; display: inline-block; width: 38px; height: 20px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #4b5563; transition: .2s; border-radius: 20px; }
    .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .2s; border-radius: 50%; }
    input:checked + .slider { background-color: var(--success); }
    input:checked + .slider:before { transform: translateX(18px); }
  </style>
</head>
<body>

  <h1>⚡ CORSAPI（API 代理 & JSON 订阅器）</h1>
  <div class="subtitle">基于 Cloudflare Workers 的中转代理，支持自动注入代理前缀并生成 Base58 格式订阅。</div>

  <h2>1. 通用 API 中转代理</h2>
  <div style="position: relative;">
    <pre id="generalProxy">${defaultPrefix}https://ikunzyapi.com/api.php/provide/vod/</pre>
  </div>

  <h2>2. 订阅链接生成</h2>

  <div class="card">
    <div class="card-title">📦 精简版</div>
    <div class="link-row">
      <div class="link-content">中转 JSON：<code>${origin}/?format=1&source=jin18</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=1&source=jin18')">复制</button>
    </div>
    <div class="link-row">
      <div class="link-content">中转 Base58：<code>${origin}/?format=3&source=jin18</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=3&source=jin18')">复制</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">📦 精简 + 成人版</div>
    <div class="link-row">
      <div class="link-content">中转 JSON：<code>${origin}/?format=1&source=jingjian</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=1&source=jingjian')">复制</button>
    </div>
    <div class="link-row">
      <div class="link-content">中转 Base58：<code>${origin}/?format=3&source=jingjian</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=3&source=jingjian')">复制</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">📦 完整版</div>
    <div class="link-row">
      <div class="link-content">中转 JSON：<code>${origin}/?format=1&source=full</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=1&source=full')">复制</button>
    </div>
    <div class="link-row">
      <div class="link-content">中转 Base58：<code>${origin}/?format=3&source=full</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=3&source=full')">复制</button>
    </div>
  </div>

  <h2>📊 资源源测速与可用性管理</h2>
  <div class="card">
    <div class="config-tabs-container">
      <span class="config-tabs-label">选择配置：</span>
      <div class="config-tabs-row">
        <button type="button" class="config-tab-btn active" id="tab-jingjian" onclick="switchSource('jingjian')">精简+成人版</button>
        <button type="button" class="config-tab-btn" id="tab-jin18" onclick="switchSource('jin18')">精简版</button>
        <button type="button" class="config-tab-btn" id="tab-full" onclick="switchSource('full')">完整版</button>
      </div>
    </div>

    <div class="btn-group">
      <button class="btn-action btn-blue" id="startBtn" onclick="runSpeedTest()">🚀 开始测速检测 (自动禁用失效源并沉底)</button>
      <button class="btn-action btn-orange" onclick="resetSources()">🔄 重置全部源 (解除禁用)</button>
      <button class="btn-action btn-green" id="saveBtn" onclick="saveState(false)">💾 保存同步</button>
    </div>

    <div class="stats-bar">
      共计: <span id="totalCount">0</span> 个源 | 
      可用: <span id="okCount" style="color:var(--success)">0</span> | 
      失效: <span id="failCount" style="color:var(--danger)">0</span> | 
      已禁用: <span id="disabledCount" style="color:var(--warning)">0</span>
    </div>

    <div style="overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th style="width: 45px; text-align: center;">状态</th>
            <th>资源名称</th>
            <th style="width: 60px; text-align: center;">API</th>
            <th style="width: 80px; text-align: center;">搜索功能</th>
            <th style="width: 85px; text-align: center;">响应延迟</th>
            <th style="width: 65px; text-align: center;">启用</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    const ORIGIN = '${origin}';
    let currentSource = 'jingjian';
    let sourcesList = ${JSON.stringify(initialList)};
    let disabledSet = new Set(${JSON.stringify(initialDisabled)});
    let testResultsMap = ${JSON.stringify(initialTestResults)};
    let isTesting = false;

    // 获取源的通用 ID
    function getItemKey(item) {
      return String(item.id || item.key || item.api || item.name || '').trim();
    }

    // 判断源是否被禁用
    function isItemDisabled(item) {
      if (!item) return false;
      const k = getItemKey(item);
      if (disabledSet.has(k)) return true;
      if (item.key && disabledSet.has(String(item.key))) return true;
      if (item.name && disabledSet.has(String(item.name))) return true;
      if (item.api && disabledSet.has(String(item.api))) return true;
      return false;
    }

    // 精确统计当前列表中已禁用的源数量（彻底解决不准确问题）
    function countDisabled() {
      let count = 0;
      for (let i = 0; i < sourcesList.length; i++) {
        if (isItemDisabled(sourcesList[i])) count++;
      }
      return count;
    }

    // 沉底排序：正常可用源置顶，失效和已禁用源沉底
    function sortSources() {
      sourcesList.sort((a, b) => {
        const disA = isItemDisabled(a);
        const disB = isItemDisabled(b);
        if (disA !== disB) return disA ? 1 : -1;

        const kA = getItemKey(a);
        const kB = getItemKey(b);
        const resA = testResultsMap[kA];
        const resB = testResultsMap[kB];
        const failA = resA ? (!resA.ok || !resA.searchOk) : false;
        const failB = resB ? (!resB.ok || !resB.searchOk) : false;
        if (failA !== failB) return failA ? 1 : -1;

        const latA = (resA && resA.latency) ? resA.latency : 99999;
        const latB = (resB && resB.latency) ? resB.latency : 99999;
        return latA - latB;
      });
    }

    // 更新统计栏数字
    function updateStats() {
      const total = sourcesList.length;
      const disabledNum = countDisabled();
      let okNum = 0;
      let failNum = 0;

      const hasHistory = Object.keys(testResultsMap).length > 0;

      sourcesList.forEach(item => {
        const k = getItemKey(item);
        const dis = isItemDisabled(item);
        const res = testResultsMap[k];
        if (res) {
          if (res.ok && res.searchOk && !dis) {
            okNum++;
          } else {
            failNum++;
          }
        }
      });

      if (!hasHistory) {
        okNum = total - disabledNum;
        failNum = 0;
      }

      document.getElementById('totalCount').innerText = total;
      document.getElementById('okCount').innerText = okNum;
      document.getElementById('failCount').innerText = failNum;
      document.getElementById('disabledCount').innerText = disabledNum;
    }

    // 渲染表格
    function renderTable() {
      sortSources();
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';

      sourcesList.forEach((item, index) => {
        const k = getItemKey(item);
        const isDis = isItemDisabled(item);
        const res = testResultsMap[k];

        let statusIcon = '⚪';
        let searchIcon = '⚪';
        let speedText = '-';
        let speedColor = 'var(--text-muted)';

        if (res) {
          statusIcon = res.ok ? '✅' : '❌';
          searchIcon = res.searchOk ? '✅' : '❌';
          if (res.latency > 0) {
            speedText = res.latency + 'ms';
            speedColor = res.latency < 1500 ? 'var(--success)' : 'var(--warning)';
          } else {
            speedText = '失败';
            speedColor = 'var(--danger)';
          }
        }

        const tr = document.createElement('tr');
        tr.id = 'row-' + index;
        if (isDis) tr.className = 'is-disabled';

        tr.innerHTML = \`
          <td style="text-align: center;"><span class="badge" id="status-\${index}">\${statusIcon}</span></td>
          <td>\${escapeHtml(item.name || '未命名')}</td>
          <td style="text-align: center;"><a class="link-btn" href="\${item.api}" target="_blank">Link</a></td>
          <td style="text-align: center;" id="search-\${index}"><span class="badge">\${searchIcon}</span></td>
          <td style="text-align: center; color:\${speedColor};" id="speed-\${index}">\${speedText}</td>
          <td style="text-align: center;">
            <label class="switch">
              <input type="checkbox" \${!isDis ? 'checked' : ''} onchange="toggleEnable(\${index}, this.checked)">
              <span class="slider"></span>
            </label>
          </td>
        \`;
        tbody.appendChild(tr);
      });

      updateStats();
    }

    // 切换配置
    async function switchSource(sourceKey) {
      if (currentSource === sourceKey && sourcesList.length > 0) return;
      currentSource = sourceKey;

      document.querySelectorAll('.config-tab-btn').forEach(btn => btn.classList.remove('active'));
      const activeBtn = document.getElementById('tab-' + sourceKey);
      if (activeBtn) activeBtn.classList.add('active');

      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color:var(--text-muted);">正在拉取资源列表...</td></tr>';

      try {
        const res = await fetch('/api/manage/sources?source=' + sourceKey);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        sourcesList = data.list || [];
        disabledSet = new Set(data.disabled || []);
        testResultsMap = data.testResults || {};
        renderTable();
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color:var(--danger); padding: 15px;">加载失败: ' + e.message + '</td></tr>';
      }
    }

    // 开关启用/禁用
    function toggleEnable(index, isChecked) {
      const item = sourcesList[index];
      if (!item) return;
      const k = getItemKey(item);

      if (isChecked) {
        disabledSet.delete(k);
        if (item.key) disabledSet.delete(String(item.key));
        if (item.name) disabledSet.delete(String(item.name));
        if (item.api) disabledSet.delete(String(item.api));
      } else {
        disabledSet.add(k);
      }

      renderTable();
    }

    // 单项真实测速与搜索检测
    async function testSingle(item, index) {
      const statusEl = document.getElementById('status-' + index);
      const searchEl = document.getElementById('search-' + index);
      const speedEl = document.getElementById('speed-' + index);

      let targetUrl = item.api;
      const delimiter = targetUrl.includes('?') ? '&' : '?';
      const testSearchUrl = ORIGIN + '/?url=' + encodeURIComponent(targetUrl + delimiter + 'ac=detail&wd=爱');

      const startTime = Date.now();
      const k = getItemKey(item);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);
        const res = await fetch(testSearchUrl, { signal: controller.signal });
        clearTimeout(timeout);

        const latency = Date.now() - startTime;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();

        const hasList = (json && (Array.isArray(json.list) && json.list.length > 0)) || json.code === 1 || json.page !== undefined;

        if (hasList) {
          testResultsMap[k] = { ok: true, searchOk: true, latency };
          speedEl.innerText = latency + 'ms';
          speedEl.style.color = latency < 1500 ? 'var(--success)' : 'var(--warning)';
          statusEl.innerHTML = '✅';
          searchEl.innerHTML = '✅';
          return true;
        } else {
          throw new Error('No search list');
        }
      } catch (e) {
        testResultsMap[k] = { ok: false, searchOk: false, latency: 0 };
        speedEl.innerText = '失败';
        speedEl.style.color = 'var(--danger)';
        statusEl.innerHTML = '❌';
        searchEl.innerHTML = '❌';

        // 自动禁用失效源
        disabledSet.add(k);

        const row = document.getElementById('row-' + index);
        if (row) {
          row.className = 'is-disabled';
          const checkbox = row.querySelector('input[type="checkbox"]');
          if (checkbox) checkbox.checked = false;
        }
        return false;
      }
    }

    // 运行测速检测：自动禁用失效源 + 自动沉底 + 自动同步保存
    async function runSpeedTest() {
      if (isTesting) return;
      isTesting = true;
      const startBtn = document.getElementById('startBtn');
      startBtn.disabled = true;
      startBtn.innerText = '⚡ 测速中 (自动禁用失效源)...';

      let ok = 0, fail = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < sourcesList.length) {
          const idx = cursor++;
          const success = await testSingle(sourcesList[idx], idx);
          if (success) ok++; else fail++;
          document.getElementById('okCount').innerText = ok;
          document.getElementById('failCount').innerText = fail;
          document.getElementById('disabledCount').innerText = countDisabled();
        }
      }

      await Promise.all(Array.from({ length: 4 }, worker));

      // 测速完成：排序沉底
      renderTable();

      // 自动同步保存至 KV
      await saveState(true);

      isTesting = false;
      startBtn.disabled = false;
      startBtn.innerText = '🚀 开始测速检测 (自动禁用失效源并沉底)';

      alert('🎉 测速已完成！\\n• 失效源已自动禁用并沉底\\n• 配置已自动保存同步至 KV 与播放器');
    }

    // 重置恢复全部源
    async function resetSources() {
      if (!confirm('确定要清空所有禁用状态，恢复所有源吗？')) return;
      try {
        await fetch('/api/manage/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: currentSource })
        });
        disabledSet.clear();
        testResultsMap = {};
        await switchSource(currentSource);
        alert('已成功重置！所有源已恢复启用。');
      } catch (e) {
        alert('重置失败: ' + e.message);
      }
    }

    // 保存同步状态到 KV
    async function saveState(isSilent = false) {
      const btn = document.getElementById('saveBtn');
      if (!isSilent) {
        btn.innerText = '保存中...';
        btn.disabled = true;
      }

      const disabledPayload = [];
      sourcesList.forEach(item => {
        if (isItemDisabled(item)) {
          if (item.key) disabledPayload.push(String(item.key));
          if (item.name) disabledPayload.push(String(item.name));
          if (item.api) disabledPayload.push(String(item.api));
        }
      });

      try {
        const res = await fetch('/api/manage/save-disabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: currentSource,
            disabled: Array.from(new Set(disabledPayload)),
            testResults: testResultsMap
          })
        });
        const ret = await res.json();
        if (ret.success) {
          if (!isSilent) {
            alert('✅ 配置已成功保存同步！播放器拉取时已自动剔除禁用源。');
          }
        } else {
          if (!isSilent) alert('保存失败: ' + (ret.error || 'KV 存储未配置'));
        }
      } catch (e) {
        if (!isSilent) alert('保存请求失败: ' + e.message);
      } finally {
        if (!isSilent) {
          btn.innerText = '💾 保存同步';
          btn.disabled = false;
        }
      }
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          alert('已复制到剪贴板！');
        }).catch(() => promptFallback(text));
      } else {
        promptFallback(text);
      }
    }

    function promptFallback(text) {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      alert('已复制到剪贴板！');
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    renderTable();
  </script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  })
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
