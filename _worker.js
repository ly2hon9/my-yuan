// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
}

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

// 快速 Base58 编码
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
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
  for (let i = 0; i < source.length && source[i] === 0; i++) output += '1'
  for (let i = digits.length - 1; i >= 0; i--) output += ALPHABET[digits[i]]
  return output
}

// 接口地址替换：剥离旧代理，拼接新前缀
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  
  const newObj = {}
  for (const key of Object.keys(obj)) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      
      // 清除可能存在的旧代理前缀
      if (apiUrl.includes('/proxy/')) {
        apiUrl = apiUrl.slice(apiUrl.indexOf('/proxy/') + 7)
      } else if (apiUrl.includes('?url=')) {
        apiUrl = apiUrl.slice(apiUrl.indexOf('?url=') + 5)
      }
      
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

// 缓存管理
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
    await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })
    return data
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return await res.json()
}

// 主逻辑
async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const currentOrigin = reqUrl.origin

  // 推荐采用干净的 /proxy/ 路径前缀，避开客户端对 ? 的误判
  const defaultPrefix = currentOrigin + '/proxy/'

  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 1. 匹配 /proxy/https://xxx 路径代理
  if (pathname.startsWith('/proxy/')) {
    const rawTarget = request.url.slice(request.url.indexOf('/proxy/') + 7)
    return handleProxyRequest(request, rawTarget, currentOrigin)
  }

  // 2. 兼容 ?url=https://xxx 传参代理
  const targetUrlParam = reqUrl.searchParams.get('url')
  if (targetUrlParam) {
    const rawTarget = request.url.slice(request.url.indexOf('?url=') + 5)
    return handleProxyRequest(request, rawTarget, currentOrigin)
  }

  // 3. 订阅转换处理
  const formatParam = reqUrl.searchParams.get('format')
  if (formatParam !== null) {
    const sourceParam = reqUrl.searchParams.get('source')
    const prefixParam = reqUrl.searchParams.get('prefix')
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 4. 默认主页说明
  return handleHomePage(currentOrigin, defaultPrefix)
}

// 代理转发模块（核心修正）
async function handleProxyRequest(request, rawTargetUrl, currentOrigin) {
  let targetUrlStr = rawTargetUrl.trim()
  try {
    targetUrlStr = decodeURIComponent(targetUrlStr)
  } catch {}

  // 纠正播放器拼接错误：如果目标地址没有 '?' 却出现了 '&'，将第一个 '&' 自动还原为 '?'
  const schemeIndex = targetUrlStr.indexOf('://')
  if (schemeIndex !== -1) {
    const pathAndQuery = targetUrlStr.slice(schemeIndex + 3)
    if (!pathAndQuery.includes('?') && pathAndQuery.includes('&')) {
      const firstAmp = targetUrlStr.indexOf('&', schemeIndex + 3)
      targetUrlStr = targetUrlStr.slice(0, firstAmp) + '?' + targetUrlStr.slice(firstAmp + 1)
    }
  }

  // 防自死循环
  if (targetUrlStr.startsWith(currentOrigin)) {
    return errorResponse('Loop detected', { url: targetUrlStr }, 400)
  }

  let targetURL
  try {
    targetURL = new URL(targetUrlStr)
  } catch {
    return errorResponse('Invalid Target URL', { url: targetUrlStr }, 400)
  }

  try {
    // 过滤与伪装请求头，彻底绕过反爬与防盗链
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

    // 统一设置常见浏览器 UA
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

    // 延长超时至 13 秒以适应慢速源
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 13000)
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
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: targetUrlStr
    }, 502)
  }
}

// 格式生成
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
    return errorResponse(err.message, {}, 500)
  }
}

// 首页使用文档
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    code { background: #f4f4f4; padding: 3px 6px; border-radius: 4px; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 6px; margin: 15px 0; }
    .copy-btn { margin-left: 8px; cursor: pointer; padding: 3px 8px; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>服务已启用，默认采用 <code>/proxy/</code> 纯净前缀解决多重参数冲突问题。</p>
  
  <h2>订阅链接（推荐使用格式 1 或 3）</h2>
  <div class="section">
    <p>中转代理 JSON：<code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
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

function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
