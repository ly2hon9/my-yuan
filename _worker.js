// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
}

// 常量配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json'
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

// 高性能 Base58 编码（基于 Uint8Array 数组运算，避免超大 BigInt 耗尽 Worker CPU）
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ALPHABET_MAP = new Uint8Array(256)
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET.charCodeAt(i)] = i
}

function base58Encode(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj)
  const source = new TextEncoder().encode(str)
  if (source.length === 0) return ''

  const digits = [0]
  for (let i = 0; i < source.length; i++) {
    let carry = source[i]
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
  // 处理前导 0 字节对应 Base58 中的 '1'
  for (let i = 0; i < source.length && source[i] === 0; i++) {
    output += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    output += ALPHABET[digits[i]]
  }
  return output
}

// JSON api 字段前缀替换
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  
  const newObj = {}
  for (const key of Object.keys(obj)) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// 安全读取/写入 KV 缓存
async function getCachedJSON(url, env) {
  const kv = env && env.KV
  const cacheKey = 'CACHE_' + url

  if (kv && typeof kv.get === 'function') {
    const cached = await kv.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await kv.delete(cacheKey)
      }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    // 缓存 30 分钟 (1800 秒)
    await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })
    return data
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return await res.json()
}

// SSRF 安全校验：阻止访问回环和局域网 IP
function isBlockedTarget(hostname) {
  const lower = hostname.toLowerCase()
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === '0.0.0.0'
  ) return true

  // 检查私有 IPv4
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [_, a, b] = ipv4Match.map(Number)
    if (a === 127) return true // 回环地址
    if (a === 10) return true  // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // 链路本地地址 / AWS 元数据
  }
  return false
}

// 主请求调度
async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // 健康检查
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 通用反代请求处理
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // 格式转换与订阅处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 首页展示
  return handleHomePage(currentOrigin, defaultPrefix)
}

// 代理请求转发模块
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 防止自身死循环
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 提取真实目标 URL（兼容客户端未对 targetUrl 内部参数做整体编码的情况）
  let fullTargetUrl = targetUrlParam
  const rawUrl = request.url
  const marker = '?url='
  const markerIndex = rawUrl.indexOf(marker)
  if (markerIndex !== -1) {
    fullTargetUrl = rawUrl.slice(markerIndex + marker.length)
    try {
      fullTargetUrl = decodeURIComponent(fullTargetUrl)
    } catch {
      // 保持原样
    }
  }

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)
  } catch {
    return errorResponse('Invalid URL format', { url: fullTargetUrl }, 400)
  }

  // 安全检查：屏蔽内网及私有地址探测 (SSRF)
  if (isBlockedTarget(targetURL.hostname)) {
    return errorResponse('Access to private/local network is forbidden', { target: targetURL.hostname }, 403)
  }

  try {
    // 过滤发往目标服务器的 Headers，删除原有的 Host 和 CDN 内部标记
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete('host')
    forwardedHeaders.delete('cf-connecting-ip')
    forwardedHeaders.delete('cf-ray')
    forwardedHeaders.delete('cf-ipcountry')
    forwardedHeaders.delete('cf-visitor')
    forwardedHeaders.delete('x-real-ip')
    forwardedHeaders.delete('x-forwarded-for')

    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
      redirect: 'follow'
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
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
    console.error('[PROXY_ERROR]', err.message, fullTargetUrl)
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// 订阅源格式处理模块
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource, env)
    
    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain; charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json; charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    console.error('[JSON_ERROR]', err.message)
    return errorResponse(err.message, {}, 500)
  }
}

// 首页使用文档 HTML
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
    .copy-btn { margin-left: 8px; cursor: pointer; padding: 2px 8px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>通用 API 中转代理，用于跨域中转与配置聚合。</p>
  
  <h2>使用方法</h2>
  <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}&lt;示例API地址&gt;</pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<code class="copyable">${currentOrigin}?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<code class="copyable">${currentOrigin}?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<code class="copyable">${currentOrigin}?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<code class="copyable">${currentOrigin}?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<code class="copyable">${currentOrigin}?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<code class="copyable">${currentOrigin}?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<code class="copyable">${currentOrigin}?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } 
  })
}

// 统一错误输出
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
