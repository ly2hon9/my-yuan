// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
}

// ================= 全局常量配置 =================
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

// 订阅源 GitHub 地址映射
const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

// 格式映射
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

// ================= 高性能 Base58 算法 =================
// 采用 Uint8Array 局部进位算法，避免使用超大 BigInt 导致 Worker CPU 超过 50ms 限制
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
  // 处理前导 0
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    output += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    output += BASE58_ALPHABET[digits[i]]
  }
  return output
}

// ================= 配置 JSON 前缀替换 =================
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))

  const newObj = {}
  for (const key of Object.keys(obj)) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      
      // 清除历史代理前缀
      if (apiUrl.includes('?url=')) {
        apiUrl = apiUrl.slice(apiUrl.indexOf('?url=') + 5)
      }
      
      // 拼接当前中转前缀
      if (!apiUrl.startsWith(newPrefix)) {
        apiUrl = newPrefix + apiUrl
      }
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// ================= 配置缓存读取 =================
async function getCachedJSON(url, env) {
  const cacheKey = 'CONFIG_CACHE_' + url

  // 优先使用 KV（如果绑定了名为 KV 的命名空间）
  if (env && env.KV && typeof env.KV.get === 'function') {
    const cached = await env.KV.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch {
        await env.KV.delete(cacheKey)
      }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch config failed: ${res.status}`)
    const data = await res.json()
    // 缓存 30 分钟 (1800 秒)
    await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })
    return data
  }

  // 未绑定 KV 时直接拉取源站
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch config failed: ${res.status}`)
  return await res.json()
}

// ================= 主路由分发 =================
async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const currentOrigin = reqUrl.origin
  const defaultPrefix = `${currentOrigin}/?url=`

  // 1. 健康检测
  if (reqUrl.pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 2. 通用 API 代理模式 (匹配 ?url=)
  if (reqUrl.searchParams.has('url') || request.url.includes('?url=')) {
    return handleProxyRequest(request, currentOrigin)
  }

  // 3. 订阅源生成模式 (匹配 ?format=)
  if (reqUrl.searchParams.has('format')) {
    const formatParam = reqUrl.searchParams.get('format')
    const sourceParam = reqUrl.searchParams.get('source') || 'full'
    const prefixParam = reqUrl.searchParams.get('prefix')
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 4. 默认主页文档
  return handleHomePage(currentOrigin, defaultPrefix)
}

// ================= API 代理核心逻辑 =================
async function handleProxyRequest(request, currentOrigin) {
  // 提取真实目标 URL（保留 url 后的全部后续查询参数）
  const marker = '?url='
  const markerIdx = request.url.indexOf(marker)
  let rawTarget = request.url.slice(markerIdx + marker.length).trim()

  try {
    rawTarget = decodeURIComponent(rawTarget)
  } catch {}

  // 🛠️ 关键修复：修复播放器误用 & 拼接搜索词的问题
  // 例如将 .../vod/&wd=test 转换为 .../vod/?wd=test
  const schemeIdx = rawTarget.indexOf('://')
  if (schemeIdx !== -1) {
    const pathAndQuery = rawTarget.slice(schemeIdx + 3)
    if (!pathAndQuery.includes('?') && pathAndQuery.includes('&')) {
      const firstAmp = rawTarget.indexOf('&', schemeIdx + 3)
      rawTarget = rawTarget.slice(0, firstAmp) + '?' + rawTarget.slice(firstAmp + 1)
    }
  }

  // 安全检查
  if (rawTarget.startsWith(currentOrigin)) {
    return jsonResponse({ error: 'Loop detected: self-fetch blocked' }, 400)
  }

  let targetURL
  try {
    targetURL = new URL(rawTarget)
  } catch {
    return jsonResponse({ error: 'Invalid URL', target: rawTarget }, 400)
  }

  try {
    // 构造请求头，去除防盗链与 Cloudflare 内部标记
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete('host')
    forwardedHeaders.delete('referer')
    forwardedHeaders.delete('origin')
    forwardedHeaders.delete('cf-connecting-ip')
    forwardedHeaders.delete('cf-ray')
    forwardedHeaders.delete('cf-ipcountry')
    forwardedHeaders.delete('cf-visitor')
    forwardedHeaders.delete('x-real-ip')
    forwardedHeaders.delete('x-forwarded-for')

    // 伪装浏览器 User-Agent
    forwardedHeaders.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    forwardedHeaders.set('accept', '*/*')

    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
      redirect: 'follow'
    })

    // 设置 12 秒超时保护
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 12000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    // 构造透传响应头，合并 CORS 配置
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
    return jsonResponse({
      error: 'Proxy Error',
      message: err.message || '代理请求失败',
      target: rawTarget
    }, 502)
  }
}

// ================= 订阅配置处理逻辑 =================
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return jsonResponse({ error: 'Invalid format parameter', format: formatParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource, env)

    // 替换 API 前缀
    const finalData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    // 输出 Base58 或 JSON
    if (config.base58) {
      const encoded = base58Encode(finalData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain; charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(finalData), {
        headers: { 'Content-Type': 'application/json; charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    return jsonResponse({ error: 'Config Process Error', message: err.message }, 500)
  }
}

// ================= 首页文档 UI =================
async function handleHomePage(origin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CORSAPI - API 代理 & JSON 订阅器</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #333; }
    h1 { font-size: 24px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
    h2 { font-size: 18px; margin-top: 25px; }
    code { background: #f4f4f5; padding: 3px 6px; border-radius: 4px; font-size: 13px; color: #d63384; }
    pre { background: #272822; color: #f8f8f2; padding: 12px; border-radius: 6px; overflow-x: auto; }
    .card { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; margin: 15px 0; }
    .link-group { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; background: #fff; padding: 8px 12px; border-radius: 6px; border: 1px solid #ddd; }
    .copy-btn { cursor: pointer; background: #0070f3; color: #fff; border: none; padding: 5px 12px; border-radius: 4px; font-size: 12px; }
    .copy-btn:hover { background: #0051a8; }
  </style>
</head>
<body>
  <h1>⚡ CORSAPI（API 代理 & JSON 订阅器）</h1>
  <p>基于 Cloudflare Workers 的中转代理，支持自动注入代理前缀并生成 Base58 格式订阅。</p>

  <h2>1. 通用 API 中转代理</h2>
  <pre>${defaultPrefix}https://ikunzyapi.com/api.php/provide/vod/</pre>

  <h2>2. 订阅链接生成</h2>
  <div class="card">
    <strong>📦 精简版（31个精选资源）</strong>
    <div class="link-group">
      <span>中转 JSON：<code>${origin}/?format=1&source=jin18</code></span>
      <button class="copy-btn" onclick="copyText('${origin}/?format=1&source=jin18')">复制</button>
    </div>
    <div class="link-group">
      <span>中转 Base58：<code>${origin}/?format=3&source=jin18</code></span>
      <button class="copy-btn" onclick="copyText('${origin}/?format=3&source=jin18')">复制</button>
    </div>
  </div>

  <div class="card">
    <strong>📦 精简 + 成人版（61个资源，推荐）</strong>
    <div class="link-group">
      <span>中转 JSON：<code>${origin}/?format=1&source=jingjian</code></span>
      <button class="copy-btn" onclick="copyText('${origin}/?format=1&source=jingjian')">复制</button>
    </div>
    <div class="link-group">
      <span>中转 Base58：<code>${origin}/?format=3&source=jingjian</code></span>
      <button class="copy-btn" onclick="copyText('${origin}/?format=3&source=jingjian')">复制</button>
    </div>
  </div>

  <div class="card">
    <strong>📦 完整版（88个资源，默认）</strong>
    <div class="link-group">
      <span>中转 JSON：<code>${origin}/?format=1&source=full</code></span>
      <button class="copy-btn" onclick="copyText('${origin}/?format=1&source=full')">复制</button>
    </div>
    <div class="link-group">
      <span>中转 Base58：<code>${origin}/?format=3&source=full</code></span>
      <button class="copy-btn" onclick="copyText('${origin}/?format=3&source=full')">复制</button>
    </div>
  </div>

  <script>
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => alert('已复制到剪贴板！'));
    }
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
