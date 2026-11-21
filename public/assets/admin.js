let state = null;
let musicQrTimer = 0;
let musicQrGeneration = 0;
let musicQueueSignature = '';
let monitorDragId = '';
let categoryDragId = '';
let touchDragKind = '';
let touchDragPointerId = null;
let touchDragTimer = 0;
let touchDragStartX = 0;
let touchDragStartY = 0;
let touchDragRow = null;
let touchDragOrder = [];
let sortSaving = false;
let updateSnoozeUntil = 0;
const updateIgnoreKey = 'status-girl-ignored-update';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const formatIncidentDuration = (incident) => {
  const start = Date.parse(incident.startedAt || incident.createdAt || '');
  const duration = incident.durationMs != null ? Number(incident.durationMs) : incident.status === 'down' && Number.isFinite(start) ? Date.now() - start : NaN;
  if (!Number.isFinite(duration)) return '未记录';
  const seconds = Math.max(0, Math.floor(duration / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const text = hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时 ${minutes % 60} 分钟` : hours ? `${hours} 小时 ${minutes % 60} 分钟 ${seconds % 60} 秒` : minutes ? `${minutes} 分钟 ${seconds % 60} 秒` : `${seconds} 秒`;
  return incident.status === 'down' && !incident.resolvedAt ? `${text}（持续中）` : text;
};
const toast = (message, danger = false) => {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('danger', danger);
  element.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove('show'), 2800);
};
function closeUpdateNotice() { $('#updateNotice')?.classList.add('hidden'); updateSnoozeUntil = Date.now() + 60 * 60 * 1000; }
function ignoredUpdateVersion() { try { return window.localStorage.getItem(updateIgnoreKey) || ''; } catch { return ''; } }
function ignoreUpdateVersion(version) { try { window.localStorage.setItem(updateIgnoreKey, version); } catch { /* private browsing may deny storage */ } }
function showUpdateNotice(update) {
  if (!update?.updateAvailable || !update.latestVersion || ignoredUpdateVersion() === update.latestVersion || Date.now() < updateSnoozeUntil) return;
  $('#updateNotice').dataset.version = update.latestVersion;
  $('#updateNoticeVersion').textContent = `当前 v${update.currentVersion} · 最新 v${update.latestVersion}`;
  $('#updateNoticeBody').textContent = update.body || '这次更新为值班室准备了一些新的变化。';
  $('#updateNoticeLink').href = update.releaseUrl || update.tagUrl || 'https://github.com/futao-awa/Status-Girl/releases';
  $('#updateNotice').classList.remove('hidden');
}
async function checkForUpdate() {
  try { showUpdateNotice(await api('/api/admin/update-check')); } catch { /* GitHub 暂时不可用不打断后台 */ }
}

async function api(url, options = {}) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(url.includes('check-now') || url.includes('/music/login/qr') ? 65000 : 20000),
      cache: 'no-store',
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && (!url.startsWith('/api/music/') || data.error === '未登录或会话已过期')) {
      showLogin();
      throw new Error(data.error || '登录已过期');
    }
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' && data.error ? data.error : `请求失败（HTTP ${response.status}）`);
      error.retryable = data.retryable ?? response.status >= 500;
      error.code = data.code;
      throw error;
    }
    return data;
  } catch (error) {
    throw error;
  }
}

function showLogin() {
  $('#updateNotice')?.classList.add('hidden');
  stopMusicQr();
  window.platformMusicPlayer?.audio.pause();
  $('#loginView')?.classList.remove('hidden');
  $('#adminApp')?.classList.add('hidden');
}
function showApp() {
  $('#loginView')?.classList.add('hidden');
  $('#adminApp')?.classList.remove('hidden');
}
function openModal(html) {
  $('#modalContent').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modalContent input, #modalContent textarea, #modalContent select')?.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalContent').innerHTML = '';
}
function categoryOptions(selected = '') {
  return `<option value="">未分类</option>${(state?.categories || []).map((category) => `<option value="${esc(category.id)}" ${category.id === selected ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}`;
}

function monitorForm(monitor = {}) {
  const editing = Boolean(monitor.id);
  return `<h2>${editing ? '编辑监控服务' : '添加监控服务'}</h2>
    <p>保存后会立即执行一次检查，地址只允许使用受支持的 HTTP、API 或 TCP 目标。</p>
    <form id="monitorForm" data-id="${esc(monitor.id || '')}">
      <div class="form-row"><label>服务名称<input name="name" required value="${esc(monitor.name || '')}"></label>
      <label>类型<select name="type"><option value="http" ${monitor.type === 'http' ? 'selected' : ''}>网站 HTTP</option><option value="api" ${monitor.type === 'api' ? 'selected' : ''}>API 接口</option><option value="tcp" ${monitor.type === 'tcp' ? 'selected' : ''}>TCP 端口</option></select></label></div>
      <label>监控地址<input name="url" required value="${esc(monitor.url || '')}" placeholder="https://example.com/health 或 db.example.com:5432"></label>
      <div class="form-row"><label>请求方法<select name="method">${['GET', 'POST', 'HEAD', 'PUT'].map((method) => `<option ${monitor.method === method ? 'selected' : ''}>${method}</option>`).join('')}</select></label>
      <label>期望状态码<input name="expectedStatus" type="number" value="${monitor.expectedStatus || 200}"></label></div>
      <div class="form-row"><label>超时（毫秒）<input name="timeoutMs" type="number" min="1000" value="${monitor.timeoutMs || 10000}"></label>
      <label>所属分类<select name="categoryId">${categoryOptions(monitor.categoryId)}</select></label></div>
      <label>期望响应文本（可选）<input name="expectedText" value="${esc(monitor.expectedText || '')}" placeholder="例如 OK 或 healthy"></label>
      <label>请求头 JSON（可选）<textarea name="headers" rows="2" placeholder='{"Authorization":"Bearer ..."}'>${esc(monitor.headers && Object.keys(monitor.headers).length ? JSON.stringify(monitor.headers) : '')}</textarea></label>
      <label>备注<input name="note" value="${esc(monitor.note || '')}" placeholder="例如：生产站点首页"></label>
      <div class="form-row"><label class="check-label"><input name="enabled" type="checkbox" ${monitor.enabled === false ? '' : 'checked'}> 启用检查</label><label class="check-label"><input name="checkSsl" type="checkbox" ${monitor.checkSsl ? 'checked' : ''}> 检查 SSL 证书</label></div>
      <div class="modal-actions"><button type="button" class="secondary" id="cancelModal">取消</button><button class="primary" type="submit">保存并检查</button></div>
    </form>`;
}
function domainForm(domain = {}) {
  return `<h2>${domain.id ? '编辑域名' : '添加域名'}</h2><p>系统会根据到期日期和提醒阈值显示风险。</p>
    <form id="domainForm" data-id="${esc(domain.id || '')}"><label>域名<input name="domain" required value="${esc(domain.domain || '')}" placeholder="example.com"></label>
    <div class="form-row"><label>到期日期<input name="expiryDate" type="date" value="${esc(domain.expiryDate || '')}"></label><label>注册商<input name="registrar" value="${esc(domain.registrar || '')}" placeholder="Cloudflare / 阿里云"></label></div>
    <label>备注<input name="note" value="${esc(domain.note || '')}"></label><label class="check-label"><input name="enabled" type="checkbox" ${domain.enabled === false ? '' : 'checked'}> 启用提醒</label>
    <div class="modal-actions"><button type="button" class="secondary" id="cancelModal">取消</button><button class="primary" type="submit">保存域名</button></div></form>`;
}
function passwordForm() {
  return `<h2>修改管理员密码</h2><p>建议使用至少 12 位、包含大小写字母与数字的强密码。</p><form id="passwordForm"><label>新密码<input name="password" type="password" minlength="12" required></label><label>再次输入<input name="confirm" type="password" minlength="12" required></label><div class="modal-actions"><button type="button" class="secondary" id="cancelModal">取消</button><button class="primary" type="submit">更新密码</button></div></form>`;
}
function usernameForm() {
  return `<h2>修改管理员用户名</h2><p>用户名用于后台登录，修改后当前会话会继续保持有效。</p><form id="usernameForm"><label>新用户名<input name="username" minlength="1" maxlength="64" autocomplete="username" required value="${esc(state?.admin?.username || '')}"></label><div class="modal-actions"><button type="button" class="secondary" id="cancelModal">取消</button><button class="primary" type="submit">更新用户名</button></div></form>`;
}

function render() {
  if (!state) return;
  const monitors = state.monitors || [];
  const up = monitors.filter((monitor) => monitor.status === 'up').length;
  const down = monitors.filter((monitor) => monitor.status === 'down').length;
  if ($('#overviewBrief')) $('#overviewBrief').textContent = `${monitors.length} 项监控服务 · ${up} 项在线 · ${down} 项异常 · ${monitors.length - up - down} 项待检查`;
  $('#statTotal').textContent = monitors.length;
  $('#statUp').textContent = up;
  $('#statDown').textContent = down;
  $('#statMemory').textContent = state.metrics ? `${state.metrics.memory.usedPercent}%` : '—';
  $('#statPlatform').textContent = state.metrics?.platform || '—';
  if ($('#adminUsername')) $('#adminUsername').textContent = state.admin?.username || 'admin';
  if ($('#adminAvatar')) $('#adminAvatar').textContent = (state.admin?.username || 'A').slice(0, 1).toUpperCase();
  $('#overviewList').innerHTML = monitors.slice(0, 8).map((monitor) => `<div class="mini-row"><i class="mini-dot ${monitor.status || 'unknown'}"></i><span>${esc(monitor.name)}</span><b class="${monitor.status || 'unknown'}">${monitor.status === 'up' ? '运营' : monitor.status === 'down' ? '异常' : '等待'}</b></div>`).join('') || '<div class="muted">暂无服务</div>';
  $('#incidentList').innerHTML = (state.incidents || []).slice(0, 7).map((incident) => `<div class="event-row"><i class="event-mark ${incident.status === 'up' ? 'up' : ''}"></i><div><strong>${esc(incident.monitorName)} · ${incident.status === 'up' ? '恢复正常' : '变为异常'}</strong><small>${formatDate(incident.createdAt)} · 故障持续 ${formatIncidentDuration(incident)}${incident.error ? ` · ${esc(incident.error)}` : ''}</small></div></div>`).join('') || '<div class="muted">暂无事件记录</div>';
  renderMonitorCategoryFilter();
  renderMonitorTable();
  renderDomains();
  renderMetrics();
  renderCategories();
  fillSettings();
  renderMusicAdmin();
  renderApiToken();
  $('#syncText').textContent = `刚刚同步 · ${formatDate(new Date().toISOString())}`;
}
function renderMonitorCategoryFilter() {
  const select = $('#monitorCategoryFilter');
  if (!select) return;
  const current = select.value;
  const options = (state?.categories || []).slice().sort((a, b) => a.sort - b.sort).map((category) => `<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('');
  select.innerHTML = `<option value="">全部分类</option>${options}<option value="__uncategorized">未分类</option>`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}
function renderMonitorTable() {
  const query = ($('#monitorSearch')?.value || '').toLowerCase();
  const filter = $('#monitorFilter')?.value || 'all';
  const categoryFilter = $('#monitorCategoryFilter')?.value || '';
  const isUncategorized = categoryFilter === '__uncategorized';
  const sortable = Boolean(categoryFilter) && !query && filter === 'all';
  const list = (state?.monitors || []).filter((monitor) => {
    const inCategory = !categoryFilter || (isUncategorized ? !(state.categories || []).some((category) => category.id === monitor.categoryId) : monitor.categoryId === categoryFilter);
    return inCategory && (!query || `${monitor.name} ${monitor.url}`.toLowerCase().includes(query)) && (filter === 'all' || (monitor.status || 'unknown') === filter);
  }).slice().sort((left, right) => Number(left.sort || 0) - Number(right.sort || 0));
  const hint = $('#monitorSortHint');
  if (hint) hint.textContent = sortable ? '拖动左侧手柄调整当前分类顺序，公开状态页会同步更新。' : categoryFilter ? '清除搜索和状态筛选后即可拖动当前分类排序。' : '先选择一个分类，再拖动左侧手柄调整公开状态页顺序。';
  $('#monitorTable').innerHTML = list.map((monitor) => `<tr data-monitor-id="${esc(monitor.id)}" draggable="${sortable}"><td class="drag-column"><span class="drag-handle" aria-label="拖动排序" title="拖动排序">⠿</span></td><td>${esc(monitor.name)}<div class="table-sub">${esc(monitor.url)}${monitor.note ? ` · ${esc(monitor.note)}` : ''}</div></td><td>${monitor.type === 'tcp' ? 'TCP' : monitor.type === 'api' ? 'API' : 'HTTP'}</td><td><span class="pill ${monitor.status || 'unknown'}">● ${monitor.status === 'up' ? '运营中' : monitor.status === 'down' ? '异常' : '未检查'}</span></td><td>${monitor.latency ? `${monitor.latency} ms` : '—'}</td><td>${formatDate(monitor.checkedAt)}</td><td><div class="row-actions"><button class="icon-btn edit-monitor" data-id="${monitor.id}" title="编辑">✎</button><button class="icon-btn danger-btn delete-monitor" data-id="${monitor.id}" title="删除">×</button></div></td></tr>`).join('') || '<tr><td colspan="7" class="muted">没有符合条件的服务。</td></tr>';
}
function renderCategories() {
  $('#categoryList').innerHTML = (state?.categories || []).slice().sort((a, b) => a.sort - b.sort).map((category) => `<div class="category-row" data-category-id="${esc(category.id)}" draggable="true"><span class="category-drag-handle" title="按住后拖动排序" aria-label="按住后拖动分类">⠿</span><span class="category-name">${esc(category.name)}</span><small>${(state.monitors || []).filter((monitor) => monitor.categoryId === category.id).length} 项服务</small><div class="row-actions"><button class="icon-btn edit-category" data-id="${category.id}">✎</button><button class="icon-btn danger-btn delete-category" data-id="${category.id}">×</button></div></div>`).join('') || '<div class="muted">暂无分类</div>';
}
async function saveCategoryOrder() {
  const ids = [...document.querySelectorAll('#categoryList .category-row')].map((row) => row.dataset.categoryId);
  if (!ids.length) return;
  const previous = state.categories.slice().sort((a, b) => a.sort - b.sort).map((category) => category.id);
  if (ids.every((id, index) => id === previous[index])) return;
  sortSaving = true;
  try {
    await api('/api/admin/categories/order', { method: 'PUT', body: JSON.stringify({ categoryIds: ids }) });
    const positions = new Map(ids.map((id, index) => [id, index]));
    state.categories.forEach((category) => { category.sort = positions.get(category.id) ?? category.sort; });
    renderMonitorCategoryFilter();
    toast('分类顺序已保存');
  } catch (error) { renderCategories(); toast(error.message, true); }
  finally { sortSaving = false; }
}
async function saveMonitorOrder() {
  const categoryFilter = $('#monitorCategoryFilter')?.value || '';
  if (!categoryFilter) return;
  const categoryId = categoryFilter === '__uncategorized' ? '' : categoryFilter;
  const ids = [...document.querySelectorAll('#monitorTable tr[data-monitor-id]')].map((row) => row.dataset.monitorId);
  if (!ids.length) return;
  const previous = state.monitors.filter((monitor) => ids.includes(monitor.id)).sort((a, b) => a.sort - b.sort).map((monitor) => monitor.id);
  if (ids.every((id, index) => id === previous[index])) return;
  sortSaving = true;
  try {
    await api('/api/admin/monitors/order', { method: 'PUT', body: JSON.stringify({ categoryId, monitorIds: ids }) });
    const positions = new Map(ids.map((id, index) => [id, index]));
    state.monitors.filter((monitor) => ids.includes(monitor.id)).forEach((monitor) => { monitor.sort = positions.get(monitor.id); });
    toast('监控顺序已保存');
  } catch (error) { renderMonitorTable(); toast(error.message, true); }
  finally { sortSaving = false; }
}
function moveSortableRow(row, pointerY) {
  const container = row.parentElement;
  const rows = [...container.querySelectorAll(':scope > [data-monitor-id], :scope > [data-category-id]')].filter((item) => item !== row);
  const before = rows.find((item) => pointerY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2);
  if (before) container.insertBefore(row, before); else container.append(row);
}
function clearTouchDrag() {
  window.clearTimeout(touchDragTimer);
  touchDragTimer = 0;
  document.querySelectorAll('.dragging, .drop-target').forEach((row) => row.classList.remove('dragging', 'drop-target'));
  touchDragKind = '';
  touchDragPointerId = null;
  touchDragStartX = 0;
  touchDragStartY = 0;
  touchDragRow = null;
  touchDragOrder = [];
}
function renderDomains() {
  $('#domainAdminList').innerHTML = (state?.domains || []).map((domain) => { const days = domain.daysRemaining; const level = days == null ? '' : days < 0 || days <= 7 ? 'danger' : days <= 30 ? 'warn' : ''; return `<div class="resource-row"><div class="resource-main"><b>${esc(domain.domain)}</b><span>${esc(domain.registrar || '未设置注册商')} · 到期 ${esc(domain.expiryDate || '未设置')}</span></div><span class="resource-days ${level}">${days == null ? '未设置' : days < 0 ? '已过期' : `${days} 天`}</span><div class="row-actions"><button class="icon-btn edit-domain" data-id="${domain.id}">✎</button><button class="icon-btn danger-btn delete-domain" data-id="${domain.id}">×</button></div></div>`; }).join('') || '<div class="muted">暂无域名记录。</div>';
}
function renderMetrics() {
  const metrics = state?.metrics;
  if (!metrics) { $('#metricAdmin').innerHTML = '<div class="muted">指标不可用</div>'; return; }
  $('#metricAdmin').innerHTML = `<div class="metric-line"><span>内存</span><b>${metrics.memory.usedPercent}% · ${Math.round(metrics.memory.used / 1024 / 1024)} MB</b></div><div class="metric-progress"><i style="width:${metrics.memory.usedPercent}%"></i></div><div class="metric-line"><span>磁盘</span><b>${metrics.disk.total ? `${metrics.disk.usedPercent}%` : '不可用'}</b></div><div class="metric-progress"><i style="width:${metrics.disk.usedPercent || 0}%"></i></div><div class="metric-line"><span>CPU 负载</span><b>${metrics.load?.join(' / ') || '—'} · ${metrics.cpuCount} 核</b></div><div class="metric-line"><span>主机</span><b>${esc(metrics.hostname)}</b></div><div class="metric-line"><span>运行时间</span><b>${Math.round(metrics.uptime / 3600)} 小时</b></div>`;
}
function fillSettings() {
  const settings = state?.settings || {};
  const form = $('#siteSettingsForm');
  if (form && !form.dataset.dirty) {
    ['siteName', 'siteDescription', 'announcement', 'refreshSeconds', 'historyDays', 'domainWarningDays', 'sslWarningDays', 'backgroundMode', 'randomBackgroundUrl', 'fixedBackgroundUrl', 'backgroundBlur', 'backgroundOpacity', 'surfaceOpacity'].forEach((key) => { if (form.elements[key]) form.elements[key].value = settings[key] ?? ''; });
    if (form.elements.publicMetrics) form.elements.publicMetrics.checked = Boolean(settings.publicMetrics);
    updateAppearanceLabels();
  }
  const notify = $('#notifyForm');
  if (!notify || notify.dataset.dirty) return;
  notify.elements.webhookUrl.value = settings.webhookUrl || '';
  notify.elements.smtpHost.value = settings.smtp?.host || '';
  notify.elements.smtpPort.value = settings.smtp?.port || 587;
  notify.elements.smtpUser.value = settings.smtp?.user || '';
  notify.elements.smtpPass.value = settings.smtp?.pass || '';
  notify.elements.smtpFrom.value = settings.smtp?.from || '';
  notify.elements.smtpTo.value = settings.smtp?.to || '';
}
function renderMusicAdmin() {
  const settings = state?.settings?.music || {};
  const provider = settings.provider || 'netease';
  if ($('#musicProvider')) $('#musicProvider').value = provider;
  const loggedIn = Boolean(settings.loggedIn);
  const status = $('#musicAdminStatus');
  if (status) { status.textContent = loggedIn ? '已连接' : '未连接'; status.classList.toggle('ready', loggedIn); }
  if ($('#musicAdminAccount')) $('#musicAdminAccount').textContent = loggedIn ? settings.account?.name || '已登录，账号资料稍后同步' : '未登录';
  if ($('#musicAdminPlaylist')) $('#musicAdminPlaylist').textContent = settings.playlistName ? `随机队列 · ${settings.playlistName}` : '随机音乐（未选择歌单）';
  if ($('#musicRandomToggle')) { $('#musicRandomToggle').setAttribute('aria-checked', String(settings.randomEnabled !== false)); $('#musicRandomToggle').title = settings.randomEnabled === false ? '启用随机音乐' : '停用随机音乐'; }
  if ($('#musicSourceLabel')) $('#musicSourceLabel').textContent = settings.playlistName || (settings.randomEnabled !== false ? '平台随机音乐' : '自选队列');
  if ($('#musicQueueCount')) $('#musicQueueCount').textContent = String((settings.queue || []).length);
  if ($('#musicRandomState')) $('#musicRandomState').textContent = settings.randomEnabled === false ? '随机音乐已停用，主页按队列顺序播放。' : (settings.playlistName ? `当前使用：${settings.playlistName} · 随机播放` : '未选择歌单时自动使用平台随机音乐。');
  renderMusicQueue();
  const signature = JSON.stringify([provider, loggedIn, settings.account?.id || settings.account?.name, settings.playlistId, settings.randomEnabled, settings.queue || []]);
  if (musicQueueSignature !== signature) {
    musicQueueSignature = signature;
    api('/api/music/config').then((config) => {
      if (musicQueueSignature === signature) {
        window.platformMusicPlayer?.updateQueue(config.queue, config);
        if (config.loggedIn && config.account && state?.settings?.music?.provider === provider) {
          state.settings.music.account = config.account;
          if ($('#musicAdminAccount')) $('#musicAdminAccount').textContent = config.account.name;
        }
      }
    }).catch((error) => {
      if (musicQueueSignature === signature) musicQueueSignature = '';
      toast(error.message, true);
    });
  }
}
function renderMusicQueue() {
  const list = $('#musicQueueList');
  if (!list) return;
  const queue = state?.settings?.music?.queue || [];
  const scroll = list.scrollTop;
  list.innerHTML = queue.map((track, index) => `<div class="music-admin-queue-row"><button class="preview-music-track" data-id="${esc(track.id)}" data-title="${esc(track.title)}" type="button" aria-label="试听 ${esc(track.title)}">▶</button><div><b>${index + 1}. ${esc(track.title)}</b><small>${esc(track.artist || '未知歌手')}${track.album ? ` · ${esc(track.album)}` : ''}</small></div><button class="icon-btn danger-btn remove-music-track" data-id="${esc(track.id)}" title="移除歌曲" aria-label="移除 ${esc(track.title)}">×</button></div>`).join('') || '<div class="muted">尚未加入歌曲。开启随机音乐后，播放器可自动获取音乐。</div>';
  list.scrollTop = scroll;
  window.platformMusicPlayer?.emitState();
}

async function toggleMusicRandom() {
  const enabled = state?.settings?.music?.randomEnabled === false;
  try { const result = await api('/api/admin/music/random', { method: 'PUT', body: JSON.stringify({ enabled }) }); await reload(); toast(result.randomEnabled ? '随机音乐已启用（空队列自动启用）' : '随机音乐已停用'); } catch (error) { toast(error.message, true); }
}

async function removeMusicTrack(button) {
  try { await api(`/api/music/queue/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' }); await reload(); toast('歌曲已移出队列'); } catch (error) { toast(error.message, true); }
}
async function changeMusicProvider() {
  stopMusicQr();
  try { await api('/api/admin/music/provider', { method: 'PUT', body: JSON.stringify({ provider: $('#musicProvider').value }) }); await reload(); $('#musicPlaylistList').innerHTML = '<div class="muted">平台已切换，请重新登录。</div>'; toast('音乐平台已切换'); } catch (error) { toast(error.message, true); }
}
function stopMusicQr() {
  musicQrGeneration += 1;
  window.clearTimeout(musicQrTimer);
  window.qishuiSigning?.dispose();
  const button = $('#musicQrButton');
  if (button) { button.disabled = false; button.textContent = '扫码登录'; }
  const box = $('#musicQrBox');
  if (box) box.hidden = true;
}
async function musicQrRequest(url, active) {
  let result = await api(url);
  for (let attempt = 0; result.signing && attempt < 3; attempt += 1) {
    if (!active()) return result;
    if (!window.qishuiSigning) throw new Error('汽水扫码组件未加载，请刷新后台后重试');
    const signature = await window.qishuiSigning.sign(result.signing);
    if (!active()) return result;
    result = await api('/api/music/login/qr/signature', { method: 'POST', body: JSON.stringify({ token: result.token, requestId: result.signing.requestId, ...signature }) });
  }
  if (result.signing && active()) throw new Error('汽水签名未完成，请重新生成二维码');
  return result;
}
async function startMusicQr() {
  stopMusicQr();
  const generation = musicQrGeneration;
  const provider = $('#musicProvider').value;
  const active = () => generation === musicQrGeneration && provider === $('#musicProvider').value;
  const button = $('#musicQrButton');
  button.disabled = true;
  button.textContent = '生成中…';
  try {
    const result = await musicQrRequest('/api/music/login/qr', active);
    if (!active()) return;
    $('#musicQrBox').hidden = false;
    $('#musicQrImage').src = result.qrCode;
    $('#musicQrImage').onerror = () => { $('#musicQrHint').textContent = '二维码图片加载失败，请重新生成'; };
    $('#musicQrHint').textContent = provider === 'qishui' ? (result.scanApp === 'douyin' ? '请使用已登录的抖音 APP 扫码，并在手机上确认登录' : '请按二维码页面提示选择 APP 扫码，并在手机上确认登录') : '使用网易云音乐扫码，并在手机上确认登录';
    let failures = 0;
    let progress = 'pending';
    const poll = async () => {
      if (!active()) return;
      if (Date.now() >= Date.parse(result.expiresAt)) { window.qishuiSigning?.dispose(); $('#musicQrHint').textContent = '二维码已过期，请重新生成'; return; }
      let retryAfterMs = 1500;
      try {
        const status = await musicQrRequest('/api/music/login/qr/status?token=' + encodeURIComponent(result.token), active);
        if (!active()) return;
        failures = 0;
        if (status.status === 'confirmed' && status.loggedIn) {
          window.qishuiSigning?.dispose();
          $('#musicQrBox').hidden = true;
          if (state?.settings?.music) { state.settings.music.loggedIn = true; state.settings.music.account = status.account; renderMusicAdmin(); }
          toast('音乐平台登录成功');
          reload().then(() => { if (active()) loadMusicPlaylists(); }).catch(error => toast('已登录，界面同步失败：' + error.message, true));
          return;
        }
        if (status.status === 'scanned' && progress !== 'authorizing') progress = 'scanned';
        if (status.status === 'authorizing' || status.status === 'confirmed') progress = 'authorizing';
        const visible = status.status === 'pending' ? progress : status.status;
        $('#musicQrHint').textContent = status.message || (visible === 'authorizing' ? '手机已确认，正在完成登录授权…' : visible === 'scanned' ? '已扫码，请在手机上确认登录…' : visible === 'expired' ? '二维码已过期，请重新生成' : '等待扫码…');
        if (status.status === 'expired' || status.status === 'verification_required') { window.qishuiSigning?.dispose(); return; }
        retryAfterMs = Math.max(1500, Math.min(10000, Number(status.retryAfterMs) || 1500));
      } catch (error) {
        if (!active()) return;
        failures += 1;
        if (error.retryable === false) { window.qishuiSigning?.dispose(); $('#musicQrHint').textContent = error.message + '，请重新生成二维码'; return; }
        $('#musicQrHint').textContent = '连接暂时中断，正在重试：' + error.message;
        retryAfterMs = Math.min(6000, 1500 + failures * 1000);
      }
      if (active()) musicQrTimer = window.setTimeout(poll, retryAfterMs);
    };
    musicQrTimer = window.setTimeout(poll, 1000);
  } catch (error) { if (active()) { window.qishuiSigning?.dispose(); toast(error.message, true); } }
  finally { if (generation === musicQrGeneration) { button.disabled = false; button.textContent = '重新生成二维码'; } }
}

async function loadMusicPlaylists() {
  const list = $('#musicPlaylistList');
  if (!list) return;
  list.innerHTML = '<div class="muted">正在读取歌单…</div>';
  try {
    const result = await api('/api/music/playlists');
    list.innerHTML = result.playlists?.map((playlist) => `<button class="music-admin-playlist ${(state?.settings?.music?.playlistId || '') === playlist.id ? 'active' : ''}" data-playlist-id="${esc(playlist.id)}" data-playlist-name="${esc(playlist.name)}"><i>♫</i><span><b>${esc(playlist.name)}</b><small>${playlist.trackCount || 0} 首歌曲</small></span><span>›</span></button>`).join('') || '<div class="muted">没有读取到歌单。</div>';
  } catch (error) { list.innerHTML = `<div class="muted">${esc(error.message)}</div>`; }
}
async function chooseMusicPlaylist(button) {
  button.disabled = true;
  try { await api(`/api/music/playlist/${encodeURIComponent(button.dataset.playlistId)}`, { method: 'POST', body: JSON.stringify({ name: button.dataset.playlistName }) }); await reload(); await loadMusicPlaylists(); toast('随机播放歌单已更新'); } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
async function searchMusic(event) {
  event.preventDefault();
  const input = $('#musicSearchInput');
  const results = $('#musicSearchResults');
  const query = input?.value.trim() || '';
  if (!query) return toast('请输入歌曲名或歌手', true);
  results.innerHTML = '<div class="muted">正在搜索音乐…</div>';
  try {
    const result = await api(`/api/music/search?q=${encodeURIComponent(query)}`);
    results.innerHTML = result.tracks?.map((track) => `<button class="music-search-result" type="button" data-track-id="${esc(track.id)}" data-track-title="${esc(track.title)}" data-track-artist="${esc(track.artist)}" data-track-album="${esc(track.album)}" data-track-cover="${esc(track.cover)}"><span><b>${esc(track.title)}</b><small>${esc(track.artist || '未知歌手')}${track.album ? ` · ${esc(track.album)}` : ''}</small></span><span>＋</span></button>`).join('') || '<div class="muted">没有找到歌曲。</div>';
  } catch (error) { results.innerHTML = `<div class="muted">${esc(error.message)}</div>`; }
}
async function addMusicTrack(button) {
  button.disabled = true;
  try {
    await api('/api/music/queue', { method: 'POST', body: JSON.stringify({ id: button.dataset.trackId, title: button.dataset.trackTitle, artist: button.dataset.trackArtist, album: button.dataset.trackAlbum, cover: button.dataset.trackCover }) });
    await reload();
    toast('歌曲已加入随机队列');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
async function clearMusicQueue() {
  try { await api('/api/music/queue', { method: 'DELETE' }); await reload(); toast('随机队列已清空'); } catch (error) { toast(error.message, true); }
}
async function logoutMusic() {
  stopMusicQr();
  try { await api('/api/music/logout', { method: 'POST', body: '{}' }); await reload(); $('#musicPlaylistList').innerHTML = '<div class="muted">已退出平台，请重新登录。</div>'; toast('已退出音乐平台'); } catch (error) { toast(error.message, true); }
}
function renderApiToken() {
  const token = state?.apiToken || {};
  const element = $('#apiTokenState');
  if (!element) return;
  element.className = `token-state ${token.configured ? 'ready' : 'empty'}`;
  element.textContent = token.configured ? `已配置 · ${token.prefix || 'Token'} · ${formatDate(token.createdAt)}` : '尚未生成 Token';
  const reveal = $('#apiTokenReveal');
  if (reveal && !reveal.dataset.pending) reveal.classList.add('hidden');
}
async function generateApiToken() {
  if (state?.apiToken?.configured && !window.confirm('重新生成后，旧 Token 会立即失效。确定继续吗？')) return;
  try {
    const result = await api('/api/admin/api-token', { method: 'POST', body: '{}' });
    $('#apiTokenValue').textContent = result.token;
    $('#apiTokenReveal').dataset.pending = 'true';
    $('#apiTokenReveal').classList.remove('hidden');
    state.apiToken = { configured: true, prefix: result.prefix, createdAt: result.createdAt };
    renderApiToken();
    $('#apiTokenReveal').dataset.pending = 'true';
    $('#apiTokenReveal').classList.remove('hidden');
    toast('Token 已生成，请立即复制保存');
  } catch (error) { toast(error.message, true); }
}
async function copyApiToken() {
  const value = $('#apiTokenValue')?.textContent || '';
  if (!value) return toast('没有可复制的 Token', true);
  try { await navigator.clipboard.writeText(value); toast('Token 已复制'); } catch { toast('复制失败，请手动复制', true); }
}
async function reload() {
  if (touchDragKind || monitorDragId || categoryDragId || sortSaving) return;
  const data = await api('/api/admin/state');
  if (touchDragKind || monitorDragId || categoryDragId || sortSaving) return;
  const previousMusic = state?.settings?.music;
  const nextMusic = data.settings?.music;
  if (nextMusic?.loggedIn && previousMusic?.loggedIn && nextMusic.provider === previousMusic.provider && !nextMusic.account) nextMusic.account = previousMusic.account;
  state = data;
  window.PageAppearance?.apply(state.settings);
  render(); renderApiDocs();
}
async function init() {
  try {
    const me = await api('/api/admin/me');
    showApp();
    if (me.mustChangePassword) $('#forcePassword').classList.remove('hidden');
    await reload();
    await checkForUpdate();
  } catch { showLogin(); }
}
function selectTab(tab) {
  const button = $(`.nav-item[data-tab="${tab}"]`);
  if (!button) return;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab}`));
  $('#tabTitle').textContent = button.querySelector('span:last-child')?.textContent || '概览';
  const descriptions = { overview: '服务运行、状态变化与资源，一目了然。', monitors: '管理监控目标、检查规则和服务分类。', domains: '关注域名到期与主机资源的真实变化。', api: '把服务状态接入你的脚本与机器人。', music: '管理公开页的音乐来源、歌单与播放队列。', settings: '设置页面信息、检查策略与通知渠道。' };
  if ($('#tabSubtitle')) $('#tabSubtitle').textContent = descriptions[tab] || '';
  window.history.replaceState(null, '', `#${tab}`);
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try { const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value }) }); showApp(); if (result.mustChangePassword) $('#forcePassword').classList.remove('hidden'); await reload(); await checkForUpdate(); toast('登录成功'); } catch (error) { $('#loginError').textContent = error.message; }
});
$('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { showLogin(); } });
$('#checkNowBtn').addEventListener('click', async () => { const button = $('#checkNowBtn'); button.disabled = true; button.textContent = '检查中…'; try { await api('/api/admin/check-now', { method: 'POST', body: '{}' }); await reload(); toast('检查已完成'); } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '立即检查'; } });
$('#generateApiToken').addEventListener('click', generateApiToken);
$('#copyApiToken').addEventListener('click', copyApiToken);
$('#monitorSearch').addEventListener('input', renderMonitorTable);
$('#monitorFilter').addEventListener('change', renderMonitorTable);
$('#monitorCategoryFilter').addEventListener('change', renderMonitorTable);
$('#musicProvider')?.addEventListener('change', changeMusicProvider);
$('#musicQrButton')?.addEventListener('click', startMusicQr);
$('#musicReloadPlaylists')?.addEventListener('click', loadMusicPlaylists);
$('#musicLogoutButton')?.addEventListener('click', logoutMusic);
$('#musicSearchForm')?.addEventListener('submit', searchMusic);
$('#musicClearQueue')?.addEventListener('click', clearMusicQueue);
$('#musicRandomToggle')?.addEventListener('click', toggleMusicRandom);

$$('.nav-item').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.go)));

$('#updateNoticeLater')?.addEventListener('click', closeUpdateNotice);
$('#updateNoticeClose')?.addEventListener('click', closeUpdateNotice);
$('#updateNoticeIgnore')?.addEventListener('click', () => {
  const version = $('#updateNotice')?.dataset.version;
  if (version) ignoreUpdateVersion(version);
  closeUpdateNotice();
});

document.addEventListener('dragstart', (event) => {
  if (touchDragKind || sortSaving || event.target.closest('button, a')) { event.preventDefault(); return; }
  const monitorRow = event.target.closest('#monitorTable tr[data-monitor-id][draggable="true"]');
  if (monitorRow) { monitorDragId = monitorRow.dataset.monitorId; monitorRow.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', monitorDragId); return; }
  const categoryRow = event.target.closest('#categoryList .category-row[draggable="true"]');
  if (categoryRow) { categoryDragId = categoryRow.dataset.categoryId; categoryRow.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', categoryDragId); }
});
document.addEventListener('dragover', (event) => {
  const monitorRow = event.target.closest('#monitorTable tr[data-monitor-id][draggable="true"]');
  const categoryRow = event.target.closest('#categoryList .category-row[draggable="true"]');
  const row = monitorRow || categoryRow;
  if (!row) return;
  if ((monitorRow && !monitorDragId) || (categoryRow && !categoryDragId)) return;
  event.preventDefault();
  document.querySelectorAll('.drop-target').forEach((item) => item.classList.remove('drop-target'));
  if (row.dataset.monitorId !== monitorDragId && row.dataset.categoryId !== categoryDragId) row.classList.add('drop-target');
  const dragging = document.querySelector('.dragging');
  if (dragging && dragging.parentElement === row.parentElement) moveSortableRow(dragging, event.clientY);
});
document.addEventListener('drop', async (event) => {
  if (monitorDragId) { event.preventDefault(); monitorDragId = ''; document.querySelectorAll('.dragging').forEach((row) => row.classList.remove('dragging')); await saveMonitorOrder(); return; }
  if (categoryDragId) { event.preventDefault(); categoryDragId = ''; document.querySelectorAll('.dragging').forEach((row) => row.classList.remove('dragging')); await saveCategoryOrder(); }
});
document.addEventListener('dragend', () => {
  const canceledMonitor = Boolean(monitorDragId);
  const canceledCategory = Boolean(categoryDragId);
  monitorDragId = ''; categoryDragId = '';
  document.querySelectorAll('.dragging, .drop-target').forEach((row) => row.classList.remove('dragging', 'drop-target'));
  if (canceledMonitor) renderMonitorTable();
  if (canceledCategory) renderCategories();
});
document.addEventListener('touchstart', (event) => {
  if (sortSaving || event.touches.length !== 1) { clearTouchDrag(); return; }
  const handle = event.target.closest('.drag-handle, .category-drag-handle');
  const categoryRow = event.target.closest('#categoryList .category-row[draggable="true"]');
  const row = handle?.closest('[data-monitor-id], [data-category-id]') || categoryRow;
  const isCategoryRow = Boolean(row?.dataset.categoryId);
  if (!row || (row.dataset.monitorId && !handle) || (row.dataset.monitorId && row.getAttribute('draggable') !== 'true') || (isCategoryRow && event.target.closest('button, a'))) return;
  const touch = event.changedTouches[0];
  touchDragPointerId = touch.identifier;
  touchDragKind = row.dataset.monitorId ? 'monitor' : 'category';
  touchDragRow = row;
  touchDragOrder = [...row.parentElement.children];
  touchDragStartX = touch.clientX;
  touchDragStartY = touch.clientY;
  touchDragTimer = window.setTimeout(() => { row.classList.add('dragging'); navigator.vibrate?.(18); }, 450);
}, { passive: true });
document.addEventListener('touchmove', (event) => {
  const touch = [...event.changedTouches].find((touch) => touch.identifier === touchDragPointerId);
  if (!touch || !touchDragKind) return;
  const dragging = touchDragRow;
  if (!dragging?.classList.contains('dragging')) {
    const moved = Math.hypot(touch.clientX - touchDragStartX, touch.clientY - touchDragStartY);
    if (moved > 10) clearTouchDrag();
    return;
  }
  event.preventDefault();
  moveSortableRow(dragging, touch.clientY);
}, { passive: false });
document.addEventListener('touchend', async (event) => {
  if (![...event.changedTouches].some((touch) => touch.identifier === touchDragPointerId) || !touchDragKind) return;
  const started = touchDragRow?.classList.contains('dragging');
  const kind = touchDragKind;
  if (started) event.preventDefault();
  clearTouchDrag();
  if (started) { if (kind === 'monitor') await saveMonitorOrder(); else await saveCategoryOrder(); }
}, { passive: false });
document.addEventListener('touchcancel', () => {
  if (touchDragRow?.parentElement) touchDragOrder.forEach((row) => touchDragRow.parentElement.append(row));
  clearTouchDrag();
});
document.addEventListener('contextmenu', (event) => { if (touchDragRow?.classList.contains('dragging') && event.target.closest('.category-row, .drag-handle')) event.preventDefault(); });

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.id === 'modalClose' || target.id === 'cancelModal') return closeModal();
  if (target.id === 'addMonitorBtn') return openModal(monitorForm());
  if (target.id === 'addDomainBtn') return openModal(domainForm());
  if (target.id === 'changeUsernameBtn') return openModal(usernameForm());
  if (target.id === 'changePasswordBtn' || target.id === 'forcePasswordBtn') return openModal(passwordForm());
  if (target.classList.contains('music-admin-playlist')) return chooseMusicPlaylist(target);
  if (target.classList.contains('music-search-result')) return addMusicTrack(target);
  if (target.classList.contains('remove-music-track')) return removeMusicTrack(target);
  if (target.classList.contains('preview-music-track')) {
    const player = window.platformMusicPlayer;
    const index = player?.queue.findIndex((track) => track.id === target.dataset.id) ?? -1;
    if (index < 0) return toast('歌曲尚未准备好，请稍后重试', true);
    if (player.trackIndex === index && player.audio.src) return player.togglePlayback();
    return player.playTrack(index);
  }
  if (target.classList.contains('edit-monitor')) return openModal(monitorForm(state.monitors.find((monitor) => monitor.id === target.dataset.id)));
  if (target.classList.contains('edit-domain')) return openModal(domainForm(state.domains.find((domain) => domain.id === target.dataset.id)));
  if (target.classList.contains('delete-monitor')) { if (!window.confirm('确定删除这个监控服务？')) return; try { await api(`/api/admin/monitors/${target.dataset.id}`, { method: 'DELETE' }); await reload(); toast('已删除'); } catch (error) { toast(error.message, true); } return; }
  if (target.classList.contains('delete-domain')) { if (!window.confirm('确定删除这个域名记录？')) return; try { await api(`/api/admin/domains/${target.dataset.id}`, { method: 'DELETE' }); await reload(); toast('已删除'); } catch (error) { toast(error.message, true); } return; }
  if (target.classList.contains('edit-category')) { const category = state.categories.find((item) => item.id === target.dataset.id); const name = window.prompt('修改分类名称', category?.name || ''); if (name?.trim()) { try { await api(`/api/admin/categories/${target.dataset.id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) }); await reload(); toast('分类已更新'); } catch (error) { toast(error.message, true); } } return; }
  if (target.classList.contains('delete-category')) { if (!window.confirm('删除分类后，服务会变为未分类。确定继续？')) return; try { await api(`/api/admin/categories/${target.dataset.id}`, { method: 'DELETE' }); await reload(); toast('分类已删除'); } catch (error) { toast(error.message, true); } }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'categoryForm') { event.preventDefault(); const name = form.elements.name.value.trim(); if (!name) return; try { await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name }) }); form.reset(); await reload(); toast('分类已添加'); } catch (error) { toast(error.message, true); } return; }
  if (form.id === 'monitorForm') { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.enabled = form.elements.enabled.checked; data.checkSsl = form.elements.checkSsl.checked; try { data.headers = data.headers ? JSON.parse(data.headers) : {}; const id = form.dataset.id; await api(id ? `/api/admin/monitors/${id}` : '/api/admin/monitors', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }); closeModal(); await reload(); toast('监控已保存'); } catch (error) { toast(error.message, true); } return; }
  if (form.id === 'domainForm') { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.enabled = form.elements.enabled.checked; try { const id = form.dataset.id; await api(id ? `/api/admin/domains/${id}` : '/api/admin/domains', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }); closeModal(); await reload(); toast('域名已保存'); } catch (error) { toast(error.message, true); } return; }
  if (form.id === 'usernameForm') { event.preventDefault(); try { const result = await api('/api/admin/account', { method: 'PUT', body: JSON.stringify({ username: form.elements.username.value.trim() }) }); closeModal(); await reload(); toast(`用户名已更新为 ${result.username}`); } catch (error) { toast(error.message, true); } return; }
  if (form.id === 'passwordForm') { event.preventDefault(); if (form.elements.password.value !== form.elements.confirm.value) return toast('两次密码不一致', true); try { await api('/api/admin/password', { method: 'PUT', body: JSON.stringify({ password: form.elements.password.value }) }); closeModal(); $('#forcePassword').classList.add('hidden'); toast('密码已更新'); } catch (error) { toast(error.message, true); } return; }
  if (form.id === 'siteSettingsForm') { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.publicMetrics = form.elements.publicMetrics.checked; data.refreshSeconds = Number(data.refreshSeconds); data.historyDays = Number(data.historyDays); data.domainWarningDays = Number(data.domainWarningDays); data.sslWarningDays = Number(data.sslWarningDays); for (const key of ['backgroundBlur', 'backgroundOpacity', 'surfaceOpacity']) data[key] = Number(data[key]); try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(data) }); delete form.dataset.dirty; await reload(); toast('页面设置已保存'); } catch (error) { toast(error.message, true); } return; }
  if (form.id === 'notifyForm') { event.preventDefault(); const data = { webhookUrl: form.elements.webhookUrl.value, smtp: { host: form.elements.smtpHost.value, port: Number(form.elements.smtpPort.value), user: form.elements.smtpUser.value, pass: form.elements.smtpPass.value, from: form.elements.smtpFrom.value, to: form.elements.smtpTo.value } }; try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(data) }); delete form.dataset.dirty; await reload(); toast('通知设置已保存'); } catch (error) { toast(error.message, true); } }
});
$('#modal').addEventListener('click', (event) => { if (event.target.id === 'modal') closeModal(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
document.addEventListener('input', (event) => { const form = event.target.closest('#siteSettingsForm, #notifyForm'); if (form) { form.dataset.dirty = 'true'; if (form.id === 'siteSettingsForm') updateAppearanceLabels(); } });
const initialTab = window.location.hash.slice(1);
if (initialTab) selectTab(initialTab);
fetch('/api/public', { signal: AbortSignal.timeout(10000), cache: 'no-store' }).then(response => response.json()).then(data => window.PageAppearance?.apply(data.settings)).catch(() => window.PageAppearance?.apply());
init();
window.setInterval(() => { if (!$('#adminApp').classList.contains('hidden')) reload().catch(() => {}); }, 30000);
window.setInterval(() => { if (!$('#adminApp').classList.contains('hidden')) checkForUpdate(); }, 10 * 60 * 1000);

function updateAppearanceLabels() {
  const form = $('#siteSettingsForm');
  for (const key of ['backgroundBlur', 'backgroundOpacity', 'surfaceOpacity']) {
    const output = $('#' + key + 'Value');
    if (output && form?.elements[key]) output.textContent = key === 'backgroundBlur' ? form.elements[key].value + ' px' : Math.round(Number(form.elements[key].value) * 100) + '%';
  }
  if (form?.elements.fixedBackgroundUrl) form.elements.fixedBackgroundUrl.required = form.elements.backgroundMode.value === 'fixed';
}
document.addEventListener('change', (event) => { if (event.target.closest('#siteSettingsForm')) updateAppearanceLabels(); });
document.addEventListener('pulse-music-change', (event) => {
  const music = event.detail;
  $('.studio-cover')?.classList.toggle('is-playing', music.playing);
  const play = $('#musicToggle');
  if (play) { play.textContent = music.playing ? 'Ⅱ' : '▶'; play.setAttribute('aria-label', music.playing ? '暂停试听' : '播放试听'); }
  $$('.preview-music-track').forEach((button) => {
    const active = button.dataset.id === music.track?.id;
    button.classList.toggle('active', active);
    button.textContent = active && music.playing ? 'Ⅱ' : '▶';
    button.setAttribute('aria-label', (active && music.playing ? '暂停 ' : '试听 ') + button.dataset.title);
  });
});

function renderApiDocs() { window.renderApiReference?.({ monitorId: state?.monitors?.find(item => item.enabled)?.id || 'MONITOR_ID' }); }
