(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const endpoints = [
    { key:'status', name:'服务总览', path:'/api/v1/status', intro:'读取全部公开服务、分类和域名状态。', fields:[['generatedAt','数据生成时间，UTC'],['summary','总服务数、正常数、故障数及最新检查时间'],['categories[].monitors','各分类的服务与历史检查结果'],['domains','已启用的域名及剩余天数']] },
    { key:'monitor', name:'单个服务', path:'/api/v1/status/{id}', intro:'按服务 ID 读取一个已启用服务的状态。ID 可从“服务总览”获取。', fields:[['monitor.id','服务唯一 ID'],['monitor.status','up 正常 · down 故障 · unknown 未检查'],['monitor.latency','最近响应耗时，单位毫秒'],['monitor.history','历史检查结果，可能尚无记录'],['monitor.ssl','证书检查结果，仅相关服务提供']] },
    { key:'events', name:'故障事件', path:'/api/v1/events', intro:'读取故障与恢复事件，按发生时间从新到旧返回。', fields:[['count','本次返回的事件数量'],['events[].id','事件 ID，用于轮询去重'],['events[].status','down 故障发生 · up 服务恢复'],['events[].createdAt','事件发生时间，UTC'],['events[].durationMs','故障持续毫秒数；null 表示未恢复或未记录']] },
    { key:'alerts', name:'当前告警', path:'/api/v1/alerts', intro:'读取当前故障、证书临期和域名临期风险。', fields:[['count','当前告警数量'],['alerts[].type','service_down · ssl_expiring · domain_expiring'],['alerts[].severity','warning 提醒 · critical 严重'],['alerts[].daysRemaining','证书或域名剩余天数，负数表示过期']] },
    { key:'health', name:'健康检查', path:'/api/v1/health', intro:'确认本监控服务是否可以响应，无需访问密钥。', fields:[['ok','本服务进程可响应，不代表所有被监控服务正常'],['uptime','进程运行时间，单位秒'],['now','服务器当前时间，UTC']] }
  ];
  let specification, loading, root, bound = false;
  let active = 'status', view = 'request', language = 'powershell', monitorId = 'MONITOR_ID';
  const selected = () => endpoints.find(item => item.key === active);
  const operation = () => specification.paths[selected().path].get;
  const requestUrl = () => location.origin + selected().path.replace('{id}', encodeURIComponent(monitorId)) + (active === 'events' ? '?limit=20' : '');
  function requestCode() {
    const url = requestUrl();
    const auth = active !== 'health';
    if (language === 'curl') return 'curl -sS ' + (auth ? '-H "Authorization: Bearer 替换为完整访问密钥" ' : '') + JSON.stringify(url);
    if (language === 'javascript') return [
      ...(auth ? ['const token = "替换为完整访问密钥";'] : []),
      'const response = await fetch(' + JSON.stringify(url) + (auth ? ', { headers: { Authorization: "Bearer " + token } }' : '') + ');',
      'const data = await response.json();',
      'if (!response.ok) throw new Error(data.error || String(response.status));',
      'console.log(data);'
    ].join(String.fromCharCode(10));
    return [
      ...(auth ? ['$token = "替换为完整访问密钥"', '$headers = @{ Authorization = "Bearer $token" }'] : []),
      'Invoke-RestMethod -Uri "' + url + '"' + (auth ? ' -Headers $headers' : '')
    ].join(String.fromCharCode(10));
  }
  function renderCode() {
    const host = root.querySelector('#apiCodePanel');
    const fields = view === 'fields';
    root.querySelector('#apiDocCodeNote').hidden = fields;
    root.querySelector('#apiDocLanguage').hidden = view !== 'request';
    root.querySelector('#copyApiDocCode').hidden = fields;
    root.querySelectorAll('[data-doc-view]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.docView === view)));
    if (fields) {
      host.innerHTML = '<div class="api-field-list">' + selected().fields.map(([key, description]) => '<div><code>' + escape(key) + '</code><span>' + escape(description) + '</span></div>').join('') + '</div>';
      return;
    }
    const sample = operation().responses['200'].content['application/json'].example;
    const code = view === 'request' ? requestCode() : JSON.stringify(sample, null, 2);
    host.innerHTML = '<pre><code>' + escape(code) + '</code></pre>';
    root.querySelector('#apiDocCodeNote').textContent = view === 'request' ? (active === 'health' ? '公开接口，可直接复制执行。' : '将“替换为完整访问密钥”改为上方生成的 Token。') : '以下为返回结构示例，不代表当前监控结果。';
  }
  function draw() {
    const item = selected();
    const params = operation().parameters || [];
    const parameters = params.length ? '<div class="api-doc-parameters"><h4>请求参数</h4><div class="api-param-list">' + params.map(parameter => '<div><code>' + escape(parameter.name) + '</code><span class="api-param-required">' + (parameter.required ? '必填 · 路径' : '选填 · 查询') + '</span><p>' + escape(parameter.description) + (parameter.name === 'id' ? '<small>当前示例已填入一个服务 ID；没有服务时请先添加监控。</small>' : '') + '</p></div>').join('') + '</div></div>' : '';
    root.innerHTML = '<nav class="panel api-endpoint-nav" aria-label="接口列表"><span class="api-nav-label">选择接口</span>' + endpoints.map(endpoint => '<button type="button" data-endpoint="' + endpoint.key + '" aria-current="' + (active === endpoint.key ? 'page' : 'false') + '"><span>' + endpoint.name + '</span><small>' + escape(endpoint.path.replace('{id}', ':id')) + '</small></button>').join('') + '</nav><article class="panel api-doc-content"><div class="api-doc-title"><div><h3>' + item.name + '</h3><p>' + item.intro + '</p></div><span class="api-auth-note">' + (active === 'health' ? '公开接口' : '需要密钥') + '</span></div><div class="api-doc-route"><span>GET</span><code>' + escape(item.path.replace('{id}', ':id')) + '</code></div>' + parameters + '<div class="api-doc-example"><div class="api-doc-codebar"><div role="tablist" aria-label="接口内容">' + [['request','调用示例'],['response','返回示例'],['fields','字段说明']].map(([key,label]) => '<button role="tab" type="button" data-doc-view="' + key + '" aria-selected="' + (view === key) + '" aria-controls="apiCodePanel">' + label + '</button>').join('') + '</div><div class="api-doc-code-actions"><select id="apiDocLanguage" aria-label="示例语言"><option value="powershell">PowerShell</option><option value="curl">cURL</option><option value="javascript">JavaScript</option></select><button id="copyApiDocCode" type="button">复制</button></div></div><div id="apiCodePanel" role="tabpanel"></div><p class="api-doc-code-note" id="apiDocCodeNote"></p></div>' + (active === 'events' ? '<p class="api-doc-note">默认返回 20 条，limit 可设为 1–100；最多检索最近 200 条。轮询建议按事件 ID 去重，重叠查询一小段时间。</p>' : '') + '<div class="api-doc-footer"><p>每 30–60 秒轮询即可。每个 IP 每分钟最多请求 120 次。</p><details><summary>鉴权与常见错误</summary><p>在请求头中传入 <code>Authorization: Bearer 完整密钥</code>，也支持 <code>X-API-Key</code>。重新生成密钥后，旧密钥立即失效。</p><div class="api-error-list"><span><b>401</b> 密钥缺失或无效</span><span><b>404</b> 服务不存在或未启用</span><span><b>429</b> 请求过快，请稍后重试</span></div><p>网络错误或 5xx 时逐步延长重试间隔。远程调用请使用 HTTPS。</p><a href="/openapi.json" download="status-girl-openapi.json">下载完整接口定义</a></details></div></article>';
    root.querySelector('#apiDocLanguage').value = language;
    renderCode();
  }
  async function load(context) {
    const previousMonitorId = monitorId;
    monitorId = context?.monitorId || monitorId;
    root = document.querySelector('#apiDocs');
    if (!root) return;
    if (!bound) {
      bound = true;
      root.addEventListener('click', async event => {
        const endpoint = event.target.closest('[data-endpoint]');
        if (endpoint && endpoints.some(item => item.key === endpoint.dataset.endpoint)) { active = endpoint.dataset.endpoint; view = 'request'; draw(); return; }
        const tab = event.target.closest('[data-doc-view]');
        if (tab) { view = tab.dataset.docView; renderCode(); return; }
        if (event.target.closest('#copyApiDocCode')) {
          const button = root.querySelector('#copyApiDocCode');
          try { await navigator.clipboard.writeText(root.querySelector('#apiCodePanel code').textContent); button.textContent = '已复制'; }
          catch { button.textContent = '请手动复制'; }
          setTimeout(() => { if (button.isConnected) button.textContent = '复制'; }, 2000);
        }
      });
      root.addEventListener('change', event => { if (event.target.id === 'apiDocLanguage') { language = event.target.value; renderCode(); } });
    }
    if (specification) { if (monitorId !== previousMonitorId && view === 'request') renderCode(); return; }
    try {
      loading ??= fetch('/openapi.json', {cache:'no-store'}).then(response => { if (!response.ok) throw new Error('文档暂时无法读取'); return response.json(); });
      specification = await loading;
      draw();
    } catch { loading = null; root.innerHTML = '<div class="panel muted">接口说明暂时无法读取，稍后将自动重试。</div>'; }
  }
  window.renderApiReference = load;
})();
