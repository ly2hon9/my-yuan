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

// 获取绑定的 KV 实例（兼容 KV 与 CONFIG_KV）
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

// ================= 源列表智能解析 =================
function extractSourceList(data) {
  if (!data) return []
  // 兼容 LunaTV 标准的 api_site 对象
  if (data.api_site && typeof data.api_site === 'object' && !Array.isArray(data.api_site)) {
    return Object.entries(data.api_site).map(([key, val]) => ({
      key: key,
      name: (val && val.name) ? val.name : key,
      api: (val && val.api) ? val.api : '',
      ...val
    }))
  }
  // 兼容数组格式
  if (Array.isArray(data)) return data
  for (const k of ['sites', 'video', 'sources', 'list']) {
    if (Array.isArray(data[k])) return data[k]
  }
  return []
}

// ================= 过滤禁用的源（拉取时不传给播放器） =================
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
    if (!kv) return jsonResponse({ error: '未检测到绑定的 KV 空间' }, 400)
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

  // 6. 首页展示：图 6 经典功能 + 图 5 测速管理表格
  return handleHomePage(currentOrigin, defaultPrefix, env)
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
        if (stored) disabledKeys = JSON.parse(stored)
      } catch {}
    }

    // 剔除禁用的源
    data = filterDisabled(JSON.parse(JSON.stringify(data)), disabledKeys)

    // 添加代理前缀
    const finalData = config.proxy ? addOrReplacePrefix(data, prefixParam || defaultPrefix) : data

    if (config.base58) {
      return new Response(base58Encode(finalData), {
        headers: { 'Content-Type': 'text/plain; charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(finalData), {
        headers: { 'Content-Type': 'application/json; charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500)
  }
}

// ================= 完整前端页面 UI =================
async function handleHomePage(origin, defaultPrefix, env) {
  // 服务端预载精简+成人版（默认），首屏直接输出源数据
  let initialList = []
  let initialDisabled = []
  try {
    const raw = await fetchConfig('jingjian', env)
    initialList = extractSourceList(raw)
    const kv = getKV(env)
    if (kv) {
      const stored = await kv.get('DISABLED_jingjian')
      if (stored) initialDisabled = JSON.parse(stored)
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

    /* 代码框与中转链接展示（图6样式） */
    pre { background: #15181e; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); font-size: 13px; overflow-x: auto; margin: 0; word-break: break-all; }
    .link-row { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; background: #15181e; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); gap: 8px; }
    .link-content { font-size: 13px; color: #cbd5e1; word-break: break-all; }
    code { font-family: monospace; color: var(--warning); background: rgba(255, 173, 31, 0.1); padding: 2px 5px; border-radius: 4px; font-size: 12.5px; }
    .btn-copy { background: #0070f3; color: #fff; border: none; padding: 5px 12px; border-radius: 5px; font-size: 12px; cursor: pointer; flex-shrink: 0; }
    .btn-copy:hover { opacity: 0.88; }

    /* 图5 测速控制区 */
    .select-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 14px; }
    select { background: #15181e; color: #fff; border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px; font-size: 13px; outline: none; }
    .btn-group { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .btn-action { border: none; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; color: #fff; }
    .btn-blue { background: #0070f3; }
    .btn-red { background: var(--danger); }
    .btn-orange { background: var(--warning); color: #000; font-weight: bold; }
    .btn-green { background: var(--success); }
    .btn-action:disabled { opacity: 0.5; cursor: not-allowed; }

    /* 统计状态条 */
    .stats-bar { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; padding: 2px 0; }
    .stats-bar span { font-weight: bold; color: #fff; margin: 0 3px; }

    /* 测速表格 */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid var(--border); padding: 10px 8px; text-align: left; }
    th { background: #161a20; color: #94a3b8; font-weight: 500; }
    tr:nth-child(even) { background: #16191f; }
    .badge { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
    a.link-btn { color: var(--primary); text-decoration: none; }
    a.link-btn:hover { text-decoration: underline; }

    /* 启用开关 */
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

  <!-- 图6 功能1：通用 API 中转代理 -->
  <h2>1. 通用 API 中转代理</h2>
  <div style="position: relative;">
    <pre id="generalProxy">${defaultPrefix}https://ikunzyapi.com/api.php/provide/vod/</pre>
  </div>

  <!-- 图6 功能2：订阅链接生成（三大版本完整保留） -->
  <h2>2. 订阅链接生成</h2>

  <div class="card">
    <div class="card-title">📦 精简版（31个精选资源）</div>
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
    <div class="card-title">📦 精简 + 成人版（61个资源，推荐）</div>
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
    <div class="card-title">📦 完整版（88个资源，默认）</div>
    <div class="link-row">
      <div class="link-content">中转 JSON：<code>${origin}/?format=1&source=full</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=1&source=full')">复制</button>
    </div>
    <div class="link-row">
      <div class="link-content">中转 Base58：<code>${origin}/?format=3&source=full</code></div>
      <button class="btn-copy" onclick="copyText('${origin}/?format=3&source=full')">复制</button>
    </div>
  </div>

  <!-- 图5 功能：资源源测速与可用性管理 -->
  <h2>📊 资源源测速与可用性管理</h2>
  <div class="card">
    <div class="select-row">
      <label>选择配置：</label>
      <select id="sourceSelect" onchange="onSourceChange()">
        <option value="jingjian" selected>精简+成人版 (推荐)</option>
        <option value="jin18">精简版</option>
        <option value="full">完整版</option>
      </select>
    </div>

    <div class="btn-group">
      <button class="btn-action btn-blue" id="startBtn" onclick="runSpeedTest()">🚀 开始测速检测</button>
      <button class="btn-action btn-red" onclick="disableFailedSources()">⛔ 禁用失效源</button>
      <button class="btn-action btn-orange" onclick="resetSources()">🔄 重置全部源 (解除禁用)</button>
      <button class="btn-action btn-green" id="saveBtn" onclick="saveState()">💾 保存同步</button>
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
    let sourcesList = ${JSON.stringify(initialList)};
    let disabledSet = new Set(${JSON.stringify(initialDisabled)});
    let isTesting = false;

    // 渲染表格
    function renderTable() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      
      let disabledNum = 0;
      sourcesList.forEach((item, index) => {
        const key = String(item.key || item.name || item.api);
        const isEnabled = !disabledSet.has(key) && !disabledSet.has(item.name) && !disabledSet.has(item.api);
        if (!isEnabled) disabledNum++;

        const tr = document.createElement('tr');
        tr.id = 'row-' + index;
        tr.innerHTML = \`
          <td style="text-align: center;"><span class="badge" id="status-\${index}">⚪</span></td>
          <td>\${escapeHtml(item.name || '未命名')}</td>
          <td style="text-align: center;"><a class="link-btn" href="\${item.api}" target="_blank">Link</a></td>
          <td style="text-align: center;" id="search-\${index}"><span class="badge">⚪</span></td>
          <td style="text-align: center; color:var(--text-muted);" id="speed-\${index}">-</td>
          <td style="text-align: center;">
            <label class="switch">
              <input type="checkbox" \${isEnabled ? 'checked' : ''} data-key="\${escapeHtml(key)}" onchange="toggleEnable(this)">
              <span class="slider"></span>
            </label>
          </td>
        \`;
        tbody.appendChild(tr);
      });

      document.getElementById('totalCount').innerText = sourcesList.length;
      document.getElementById('disabledCount').innerText = disabledNum;
    }

    // 下拉框切换
    async function onSourceChange() {
      const source = document.getElementById('sourceSelect').value;
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color:var(--text-muted);">正在拉取资源列表...</td></tr>';
      
      try {
        const res = await fetch('/api/manage/sources?source=' + source);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        sourcesList = data.list || [];
        disabledSet = new Set(data.disabled || []);
        renderTable();
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color:var(--danger); padding: 15px;">加载失败: ' + e.message + '</td></tr>';
      }
    }

    function toggleEnable(el) {
      const key = el.getAttribute('data-key');
      if (el.checked) {
        disabledSet.delete(key);
      } else {
        disabledSet.add(key);
      }
      document.getElementById('disabledCount').innerText = disabledSet.size;
    }

    // 单个测速与搜索检测
    async function testSingle(item, index) {
      const statusEl = document.getElementById('status-' + index);
      const searchEl = document.getElementById('search-' + index);
      const speedEl = document.getElementById('speed-' + index);

      let targetUrl = item.api;
      const delimiter = targetUrl.includes('?') ? '&' : '?';
      const testSearchUrl = ORIGIN + '/?url=' + encodeURIComponent(targetUrl + delimiter + 'ac=detail&wd=爱');

      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(testSearchUrl, { signal: controller.signal });
        clearTimeout(timeout);
        
        const latency = Date.now() - startTime;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        
        // 校验是否有有效电影列表或规范响应
        const hasList = (json && (Array.isArray(json.list) && json.list.length > 0)) || json.code === 1 || json.page !== undefined;

        speedEl.innerText = latency + 'ms';
        speedEl.style.color = latency < 1500 ? 'var(--success)' : 'var(--warning)';
        statusEl.innerHTML = '✅';

        if (hasList) {
          searchEl.innerHTML = '✅';
          return true;
        } else {
          searchEl.innerHTML = '❌';
          return false;
        }
      } catch (e) {
        speedEl.innerText = '失败';
        speedEl.style.color = 'var(--danger)';
        statusEl.innerHTML = '❌';
        searchEl.innerHTML = '❌';
        return false;
      }
    }

    // 并发测速
    async function runSpeedTest() {
      if (isTesting) return;
      isTesting = true;
      document.getElementById('startBtn').disabled = true;
      let ok = 0, fail = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < sourcesList.length) {
          const idx = cursor++;
          const success = await testSingle(sourcesList[idx], idx);
          if (success) ok++; else fail++;
          document.getElementById('okCount').innerText = ok;
          document.getElementById('failCount').innerText = fail;
        }
      }

      await Promise.all(Array.from({ length: 4 }, worker));
      isTesting = false;
      document.getElementById('startBtn').disabled = false;
    }

    // 禁用失效源
    function disableFailedSources() {
      sourcesList.forEach((item, index) => {
        const searchEl = document.getElementById('search-' + index);
        if (searchEl && searchEl.innerText.includes('❌')) {
          const key = String(item.key || item.name || item.api);
          disabledSet.add(key);
        }
      });
      renderTable();
    }

    // 重置恢复全部
    async function resetSources() {
      if (!confirm('确定要清空所有禁用状态，恢复所有源吗？')) return;
      const source = document.getElementById('sourceSelect').value;
      try {
        await fetch('/api/manage/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source })
        });
        disabledSet.clear();
        await onSourceChange();
        alert('已成功重置！所有源已恢复启用。');
      } catch (e) {
        alert('重置失败: ' + e.message);
      }
    }

    // 保存状态到 KV
    async function saveState() {
      const source = document.getElementById('sourceSelect').value;
      const btn = document.getElementById('saveBtn');
      btn.innerText = '保存中...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/manage/save-disabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: source,
            disabled: Array.from(disabledSet)
          })
        });
        const ret = await res.json();
        if (ret.success) {
          alert('配置已成功保存！播放器拉取订阅时已自动剔除禁用源。');
        } else {
          alert('保存失败: ' + (ret.error || 'KV 存储未配置'));
        }
      } catch (e) {
        alert('保存失败: ' + e.message);
      } finally {
        btn.innerText = '💾 保存同步';
        btn.disabled = false;
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

    // 首屏直接渲染预加载的源
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
