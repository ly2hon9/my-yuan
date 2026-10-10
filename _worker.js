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

// ================= Base58 编码 =================
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

// ================= 代理前缀替换 =================
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

// ================= 过滤禁用的源 =================
function filterDisabled(data, disabledKeys = []) {
  if (!Array.isArray(data) && typeof data === 'object') {
    // 兼容可能包装在 sites 或 source 字段中的数据结构
    for (const k of ['sites', 'source', 'list']) {
      if (Array.isArray(data[k])) {
        data[k] = data[k].filter(item => !disabledKeys.includes(item.key || item.name || item.api))
      }
    }
    return data
  }
  if (Array.isArray(data)) {
    return data.filter(item => !disabledKeys.includes(item.key || item.name || item.api))
  }
  return data
}

// 读取缓存源
async function getCachedJSON(url, env) {
  const cacheKey = 'CONFIG_CACHE_' + url
  if (env && env.KV && typeof env.KV.get === 'function') {
    const cached = await env.KV.get(cacheKey)
    if (cached) {
      try { return JSON.parse(cached) } catch {}
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })
    return data
  }
  const res = await fetch(url)
  return await res.json()
}

// ================= 路由分发 =================
async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const currentOrigin = reqUrl.origin
  const defaultPrefix = `${currentOrigin}/?url=`

  // 1. 代理转发请求
  if (reqUrl.searchParams.has('url') || request.url.includes('?url=')) {
    return handleProxyRequest(request, currentOrigin)
  }

  // 2. 获取源列表与禁用状态（用于前端测速页面）
  if (reqUrl.pathname === '/api/manage/sources') {
    const sourceKey = reqUrl.searchParams.get('source') || 'jingjian'
    const sourceUrl = JSON_SOURCES[sourceKey] || JSON_SOURCES['jingjian']
    try {
      const data = await getCachedJSON(sourceUrl, env)
      let disabledList = []
      if (env && env.KV) {
        const stored = await env.KV.get(`DISABLED_${sourceKey}`)
        if (stored) disabledList = JSON.parse(stored)
      }
      return jsonResponse({ list: Array.isArray(data) ? data : (data.sites || []), disabled: disabledList })
    } catch (e) {
      return jsonResponse({ error: e.message }, 500)
    }
  }

  // 3. 保存禁用列表
  if (reqUrl.pathname === '/api/manage/save-disabled' && request.method === 'POST') {
    if (!env || !env.KV) {
      return jsonResponse({ error: '未绑定 KV 存储空间，无法持久化保存' }, 400)
    }
    try {
      const body = await request.json()
      const { source, disabled } = body
      await env.KV.put(`DISABLED_${source || 'jingjian'}`, JSON.stringify(disabled || []))
      return jsonResponse({ success: true })
    } catch (e) {
      return jsonResponse({ error: e.message }, 500)
    }
  }

  // 4. 播放器拉取订阅转换（过滤掉被禁用的源）
  if (reqUrl.searchParams.has('format')) {
    const formatParam = reqUrl.searchParams.get('format')
    const sourceParam = reqUrl.searchParams.get('source') || 'full'
    const prefixParam = reqUrl.searchParams.get('prefix')
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  // 5. 首页：使用文档 + 测速管理表格
  return handleHomePage(currentOrigin, defaultPrefix)
}

// ================= API 代理核心 =================
async function handleProxyRequest(request, currentOrigin) {
  const marker = '?url='
  const markerIdx = request.url.indexOf(marker)
  let rawTarget = request.url.slice(markerIdx + marker.length).trim()
  try { rawTarget = decodeURIComponent(rawTarget) } catch {}

  // 纠正播放器搜索参数
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
    return jsonResponse({ error: 'Invalid URL', target: rawTarget }, 400)
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

// ================= 生成订阅处理（带过滤） =================
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) return jsonResponse({ error: 'Invalid format' }, 400)

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    let data = await getCachedJSON(selectedSource, env)

    // 读取禁用列表并过滤
    let disabledKeys = []
    if (env && env.KV) {
      const stored = await env.KV.get(`DISABLED_${sourceParam}`)
      if (stored) disabledKeys = JSON.parse(stored)
    }
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

// ================= 前端页面 =================
async function handleHomePage(origin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>源配置管理与测速检测</title>
  <style>
    :root {
      --bg: #14171a;
      --card-bg: #1e2227;
      --border: #2e343d;
      --text: #e1e8ed;
      --text-muted: #8899a6;
      --primary: #1da1f2;
      --danger: #e0245e;
      --success: #17bf63;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1080px; margin: 30px auto; padding: 0 15px; background: var(--bg); color: var(--text); line-height: 1.5; }
    h1, h2 { color: #fff; margin-bottom: 12px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin-bottom: 24px; }
    .copy-row { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; background: #16181d; padding: 8px 12px; border-radius: 6px; }
    code { font-family: monospace; color: #ffad1f; font-size: 13px; word-break: break-all; }
    button { background: var(--primary); color: #fff; border: none; padding: 7px 14px; border-radius: 5px; cursor: pointer; font-size: 13px; transition: 0.2s; }
    button:hover { opacity: 0.85; }
    button.btn-danger { background: var(--danger); }
    button.btn-success { background: var(--success); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* 测速控制条 */
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 15px; }
    .stats { font-size: 14px; color: var(--text-muted); }
    .stats span { font-weight: bold; color: #fff; margin: 0 4px; }

    /* 测速表格 - 复刻图例样式 */
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { border: 1px solid var(--border); padding: 10px 12px; text-align: left; }
    th { background: #181b20; color: #aab8c2; }
    tr:nth-child(even) { background: #1b1e23; }
    .status-badge { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; font-size: 14px; }
    .badge-ok { background: rgba(23, 191, 99, 0.2); color: var(--success); }
    .badge-fail { background: rgba(224, 36, 94, 0.2); color: var(--danger); }
    .badge-wait { background: rgba(136, 153, 166, 0.2); color: var(--text-muted); }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    
    /* 启用/禁用 开关 */
    .switch { position: relative; display: inline-block; width: 38px; height: 20px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #4b5563; transition: .3s; border-radius: 20px; }
    .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
    input:checked + .slider { background-color: var(--success); }
    input:checked + .slider:before { transform: translateX(18px); }
  </style>
</head>
<body>

  <h2>⚡ 订阅配置拉取</h2>
  <div class="card">
    <p style="margin: 0 0 10px 0; font-size: 13px; color: var(--text-muted);">
      💡 下方表格中<strong>被禁用的源在此处拉取时将自动过滤排除</strong>，不会同步到您的播放器中。
    </p>
    <div class="copy-row">
      <span>📦 精简+成人 (推荐): <code>${origin}/?format=1&source=jingjian</code></span>
      <button onclick="copy('${origin}/?format=1&source=jingjian')">复制</button>
    </div>
    <div class="copy-row">
      <span>📦 Base58 格式: <code>${origin}/?format=3&source=jingjian</code></span>
      <button onclick="copy('${origin}/?format=3&source=jingjian')">复制</button>
    </div>
  </div>

  <h2>📊 资源源测速与可用性管理</h2>
  <div class="card">
    <div class="toolbar">
      <div>
        <label>选择配置：</label>
        <select id="sourceSelect" onchange="loadSources()" style="background:#16181d; color:#fff; border:1px solid var(--border); padding:5px 8px; border-radius:4px;">
          <option value="jingjian" selected>精简+成人版 (推荐)</option>
          <option value="jin18">精简版</option>
          <option value="full">完整版</option>
        </select>
        <button id="startBtn" onclick="runSpeedTest()" style="margin-left: 10px;">🚀 开始测速检测</button>
        <button class="btn-danger" onclick="disableFailedSources()">⛔ 一键禁用失效源</button>
      </div>
      <div>
        <button class="btn-success" id="saveBtn" onclick="saveDisabledState()">💾 保存配置同步至播放器</button>
      </div>
    </div>

    <div class="stats" id="statsBar">
      共计: <span id="totalCount">0</span> 个源 | 
      可用: <span id="okCount" style="color:var(--success)">0</span> | 
      失效: <span id="failCount" style="color:var(--danger)">0</span> | 
      已禁用: <span id="disabledCount" style="color:#ffad1f">0</span>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 50px; text-align: center;">状态</th>
          <th>资源名称</th>
          <th style="width: 80px;">API</th>
          <th style="width: 90px; text-align: center;">搜索功能</th>
          <th style="width: 90px; text-align: center;">响应延迟</th>
          <th style="width: 70px; text-align: center;">启用</th>
        </tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">正在加载资源列表...</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    const ORIGIN = '${origin}';
    let sourcesList = [];
    let disabledSet = new Set();
    let isTesting = false;

    // 加载数据
    async function loadSources() {
      const source = document.getElementById('sourceSelect').value;
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">加载中...</td></tr>';
      
      try {
        const res = await fetch('/api/manage/sources?source=' + source);
        const data = await res.json();
        sourcesList = data.list || [];
        disabledSet = new Set(data.disabled || []);
        renderTable();
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color:var(--danger);">加载失败: ' + e.message + '</td></tr>';
      }
    }

    // 渲染表格 (去除了成功/失败次数)
    function renderTable() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      
      let disabledNum = 0;
      sourcesList.forEach((item, index) => {
        const key = item.key || item.name || item.api;
        const isEnabled = !disabledSet.has(key);
        if (!isEnabled) disabledNum++;

        const tr = document.createElement('tr');
        tr.id = 'row-' + index;
        tr.innerHTML = \`
          <td style="text-align: center;">
            <span class="status-badge badge-wait" id="status-\${index}">⚪</span>
          </td>
          <td>\${escapeHtml(item.name || '未命名')}</td>
          <td><a href="\${item.api}" target="_blank">Link</a></td>
          <td style="text-align: center;" id="search-\${index}">
            <span class="status-badge badge-wait">⚪</span>
          </td>
          <td style="text-align: center;" id="speed-\${index}">-</td>
          <td style="text-align: center;">
            <label class="switch">
              <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="toggleEnable('\${escapeHtml(key)}', this.checked)">
              <span class="slider"></span>
            </label>
          </td>
        \`;
        tbody.appendChild(tr);
      });

      document.getElementById('totalCount').innerText = sourcesList.length;
      document.getElementById('disabledCount').innerText = disabledNum;
    }

    // 切换启用/禁用
    function toggleEnable(key, enabled) {
      if (enabled) {
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
      // 搜索检测参数（检索常见词测试真实检索能力）
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

        // 判断是否有有效数据返回
        const hasList = (json && (Array.isArray(json.list) && json.list.length > 0)) || json.code === 1;

        speedEl.innerText = latency + 'ms';
        speedEl.style.color = latency < 1500 ? 'var(--success)' : '#ffad1f';

        statusEl.className = 'status-badge badge-ok';
        statusEl.innerHTML = '✅';

        if (hasList) {
          searchEl.className = 'status-badge badge-ok';
          searchEl.innerHTML = '✅';
          return true;
        } else {
          searchEl.className = 'status-badge badge-fail';
          searchEl.innerHTML = '❌';
          return false;
        }
      } catch (e) {
        speedEl.innerText = '超时/失败';
        speedEl.style.color = 'var(--danger)';
        statusEl.className = 'status-badge badge-fail';
        statusEl.innerHTML = '❌';
        searchEl.className = 'status-badge badge-fail';
        searchEl.innerHTML = '❌';
        return false;
      }
    }

    // 批量并发测速（并发数 4，防止打满）
    async function runSpeedTest() {
      if (isTesting) return;
      isTesting = true;
      document.getElementById('startBtn').disabled = true;
      let ok = 0, fail = 0;

      const pool = 4;
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

      await Promise.all(Array.from({ length: pool }, worker));
      isTesting = false;
      document.getElementById('startBtn').disabled = false;
    }

    // 一键禁用失效源
    function disableFailedSources() {
      sourcesList.forEach((item, index) => {
        const searchEl = document.getElementById('search-' + index);
        if (searchEl && searchEl.innerText.includes('❌')) {
          const key = item.key || item.name || item.api;
          disabledSet.add(key);
        }
      });
      renderTable();
    }

    // 保存禁用状态到 Cloudflare KV
    async function saveDisabledState() {
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
          alert('保存失败: ' + (ret.error || '未知错误，请检查是否绑定了 KV 命名空间'));
        }
      } catch (e) {
        alert('请求失败: ' + e.message);
      } finally {
        btn.innerText = '💾 保存配置同步至播放器';
        btn.disabled = false;
      }
    }

    function copy(text) {
      navigator.clipboard.writeText(text).then(() => alert('已复制到剪贴板！'));
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    window.onload = loadSources;
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
