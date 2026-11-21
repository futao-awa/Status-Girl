const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmtTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const fmtDate = (value) => value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
const typeLabel = { http: '网站', api: '接口', tcp: 'TCP' };
const stateLabel = { up: '运营中', down: '异常', unknown: '待检查' };
const stateClass = (state) => state === 'up' || state === 'down' ? state : 'unknown';
const DECORATIONS = ['snow', 'paper'];
let servicesRendered = false;
let searchBound = false;
let currentView = 'services';
let activeCategory = 'all';
let eventsPage = 1;
const EVENTS_PAGE_SIZE = 8;
let nextRefreshAt = 0;
let lastCheckedAt = 0;
let schedulerRunning = false;
let refreshFetchTimer = 0;
let loadingPromise = null;
let latestData = null;
let activeMonitorId = '';
let bootFinished = false;
let backgroundLoadPromise = null;
const bootStartedAt = performance.now();

function finishInitialLoad(dataReadyPromise) {
  if (bootFinished) return;
  let fallbackTimer;
  const reveal = () => {
    if (bootFinished) return;
    bootFinished = true;
    window.clearTimeout(fallbackTimer);
    document.body.classList.add('wallpaper-ready');
    document.body.classList.remove('is-loading');
    $('#pageLoader')?.classList.add('is-hidden');

  };
  fallbackTimer = window.setTimeout(reveal, 3200);
  Promise.resolve(dataReadyPromise).catch(() => {}).then(() => Promise.allSettled([backgroundLoadPromise || Promise.resolve()]))
    .then(() => window.setTimeout(reveal, Math.max(0, 1850 - (performance.now() - bootStartedAt))));
}

function loadRandomBackground(settings = {}) {
  backgroundLoadPromise = window.PageAppearance?.apply(settings) || Promise.resolve();
  return backgroundLoadPromise;
}

let decorationTransitionTimer = 0;
function refreshDecoration(apply) {
  const loader = $('#pageLoader');
  if (!loader) { apply(); return; }
  window.clearTimeout(decorationTransitionTimer);
  loader.classList.add('is-switching');
  loader.classList.remove('is-hidden');
  loader.querySelector('.loader-line span').textContent = '正在切换装饰';
  decorationTransitionTimer = window.setTimeout(() => {
    apply();
    loader.classList.remove('is-switching');
    loader.classList.add('is-hidden');
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 100 : 1450);
}

function fmtCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateCountdown() {
  const target = $('#refreshCountdown');
  if (!target) return;
  if (schedulerRunning) {
    target.textContent = '正在检查…';
    target.classList.add('is-now');
    return;
  }
  const remaining = nextRefreshAt - Date.now();
  target.textContent = nextRefreshAt > 0 && remaining > 0 ? `下次检查 ${fmtCountdown(remaining)}` : '等待计划…';
  target.classList.toggle('is-now', nextRefreshAt > 0 && remaining <= 0);
}

function historyCells(history = [], count = 60) {
  const points = Array.isArray(history) ? history.slice(-count) : [];
  return Array.from({ length: count }, (_, index) => {
    const point = points[index - count + points.length];
    if (!point) return '<i class="heat-cell empty" title="暂无记录"></i>';
    return `<i class="heat-cell ${point.ok ? 'up' : 'down'}" title="${esc(fmtTime(point.checkedAt))} · ${point.ok ? '正常' : '异常'}${point.latency ? ` · ${point.latency}ms` : ''}"></i>`;
  }).join('');
}

function flattenMonitors(data) {
  return (data.categories || []).flatMap((category) => (category.monitors || []).map((monitor) => ({ ...monitor, categoryName: category.name, categoryId: category.id })));
}

function aggregateHistory(monitors) {
  return Array.from({ length: 60 }, (_, index) => {
    const points = monitors.map((monitor) => (monitor.history || []).slice(-60)[index - 60 + (monitor.history || []).slice(-60).length]).filter(Boolean);
    if (!points.length) return 'empty';
    return points.some((point) => !point.ok) ? 'down' : 'up';
  });
}

function renderOverall(data, monitors) {
  const summary = data.summary || {};
  const overall = summary.overall || 'partial';
  const card = $('#overallCard');
  const icon = $('#overallIcon');
  const history = monitors.flatMap((monitor) => monitor.history || []);
  const upRate = history.length ? `${((history.filter((point) => point.ok).length / history.length) * 100).toFixed(2)}%` : '—';
  const statusText = overall === 'up' ? '所有系统运营' : overall === 'down' ? '有服务需要关注' : '状态正在同步';
  card?.classList.remove('is-up', 'is-down', 'is-partial');
  card?.classList.add(`is-${overall}`);
  if (icon) { icon.textContent = overall === 'up' ? '✓' : overall === 'down' ? '!' : '·'; icon.className = `overall-icon ${overall}`; }
  if ($('#overallTitle')) $('#overallTitle').textContent = summary.total ? statusText : '尚未添加监控';
  if ($('#overallSub')) $('#overallSub').textContent = summary.checkedAt ? `上次检查 ${fmtTime(summary.checkedAt)}` : '等待第一次检查完成';
  if ($('#summaryText')) $('#summaryText').textContent = summary.total ? upRate : '—';
  if ($('#footprintTotal')) $('#footprintTotal').textContent = String(summary.total || 0).padStart(2, '0');
  if ($('#footprintLatest')) {
    const latencyValues = monitors.map((monitor) => monitor.latency).filter((value) => typeof value === 'number' && Number.isFinite(value));
    $('#footprintLatest').textContent = latencyValues.length ? `${Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)}ms` : '—';
  }
  if ($('#lastUpdated')) $('#lastUpdated').textContent = summary.checkedAt ? `更新于 ${fmtTime(summary.checkedAt)}` : '等待更新';
  if ($('#historyDaysLabel')) $('#historyDaysLabel').textContent = '最近 60 次检查';
  if ($('#statusFootprint')) $('#statusFootprint').innerHTML = aggregateHistory(monitors).map((status, index) => `<i class="heat-cell ${status}" title="第 ${index + 1} 次检查"></i>`).join('');
  const checkedAt = Date.parse(summary.checkedAt || '') || 0;
  const serverNextCheckAt = Date.parse(data.scheduler?.nextCheckAt || '') || 0;
  schedulerRunning = Boolean(data.scheduler?.running);
  if (serverNextCheckAt) nextRefreshAt = serverNextCheckAt;
  else if (schedulerRunning) nextRefreshAt = 0;
  lastCheckedAt = checkedAt || lastCheckedAt;
  updateCountdown();
  scheduleRefreshFetch();
}

function eventCopy(incident) {
  const error = String(incident.error || '');
  const isUp = incident.status === 'up';
  const downTitles = ['哎呀，刚才还嘴硬，现在掉线啦', '别装睡啦，服务真的失联了', '警报响了：这位选手先歇菜了', '连接断开，现场开始冒小问号'];
  const upTitles = ['又跑回来啦，算你反应快', '成功复活，刚才只是小小迷路', '重新上线，继续稳稳工作', '恢复运营，刚才的插曲到此为止'];
  const seed = [...String(incident.id || ''), ...String(incident.monitorName || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const title = (isUp ? upTitles : downTitles)[seed % (isUp ? upTitles.length : downTitles.length)];
  const code = error.match(/\b[45]\d{2}\b/)?.[0];
  const reason = isUp ? '最近一次检查已经恢复正常。' : (code ? `收到 ${code} 响应，服务暂时没有接住请求。` : error ? error : '检查没有得到有效响应，建议查看服务日志。');
  const detail = isUp ? '状态已回到绿色区域，可以继续观察后续几次检查。' : '先检查进程、反向代理、证书和上游网络，通常可以很快找到线索。';
  return { title, reason, detail };
}

function durationBetween(start, end) {
  const milliseconds = Math.max(0, (Date.parse(end || '') || Date.now()) - (Date.parse(start || '') || Date.now()));
  const days = Math.floor(milliseconds / 86400000);
  if (days >= 1) return `${days} 天`;
  const hours = Math.floor(milliseconds / 3600000);
  if (hours >= 1) return `${hours} 小时`;
  const minutes = Math.max(1, Math.floor(milliseconds / 60000));
  return `${minutes} 分钟`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  if (!Number.isFinite(totalSeconds)) return '未记录';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
  if (hours) return `${hours} 小时 ${minutes} 分钟 ${seconds} 秒`;
  return minutes ? `${minutes} 分钟 ${seconds} 秒` : `${seconds} 秒`;
}

function incidentDuration(incident) {
  if (incident.durationMs != null && Number.isFinite(Number(incident.durationMs))) return formatDuration(incident.durationMs);
  if (incident.status === 'down') {
    const startedAt = Date.parse(incident.startedAt || incident.createdAt || '');
    if (startedAt) return formatDuration(Date.now() - startedAt);
  }
  return '持续时间未记录';
}

function statsFor(monitor) {
  const history = Array.isArray(monitor.history) ? monitor.history : [];
  const latencies = history.map((point) => point.latency).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const okCount = history.filter((point) => point.ok).length;
  return {
    history,
    total: history.length,
    okCount,
    downCount: history.filter((point) => !point.ok).length,
    availability: history.length ? ((okCount / history.length) * 100).toFixed(3) : '—',
    average: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    maximum: latencies.length ? Math.max(...latencies) : 0,
    minimum: latencies.length ? Math.min(...latencies) : 0,
    duration: history.length ? durationBetween(history[0].checkedAt, history.at(-1).checkedAt || monitor.checkedAt) : '等待首个检查'
  };
}

function responseChartMarkup(history) {
  const samples = history.length > 120 ? history.filter((_point, index) => index % Math.ceil(history.length / 120) === 0) : history;
  const values = samples.map((point) => Number(point.latency)).filter(Number.isFinite);
  if (values.length < 2) return '<div class="detail-chart-empty">还没有足够的响应时间记录</div>';
  const width = 820;
  const height = 170;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);
  const points = values.map((value, index) => `${((index / (values.length - 1)) * width).toFixed(2)},${(height - ((value - min) / span) * (height - 18) - 8).toFixed(2)}`);
  const first = points[0].split(',');
  const last = points.at(-1).split(',');
  const area = `M ${first[0]} ${height} L ${points.join(' L ')} L ${last[0]} ${height} Z`;
  return `<svg class="response-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="响应时间趋势图"><defs><linearGradient id="responseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#48c884" stop-opacity=".3"/><stop offset="1" stop-color="#48c884" stop-opacity="0"/></linearGradient></defs><path class="chart-grid" d="M0 36H${width} M0 84H${width} M0 132H${width}"/><path class="chart-area" d="${area}"/><polyline class="chart-line" points="${points.join(' ')}"/><circle class="chart-point" cx="${last[0]}" cy="${last[1]}" r="4"/></svg>`;
}

function detailEventMarkup(monitor) {
  const events = (latestData?.incidents || []).filter((incident) => incident.monitorId === monitor.id).slice(0, 4);
  if (!events.length) return '<div class="detail-events-empty">暂无状态变化记录，最近检查保持稳定。</div>';
  return events.map((incident) => {
    const copy = eventCopy(incident);
    return `<div class="detail-event-row"><span class="detail-event-icon ${incident.status === 'up' ? 'up' : 'down'}">${incident.status === 'up' ? '↑' : '↓'}</span><div><strong>${esc(copy.title)}</strong><p>${esc(copy.reason)}<br>故障持续：${esc(incidentDuration(incident))}</p></div><time>${esc(fmtTime(incident.createdAt))}</time></div>`;
  }).join('');
}

function monitorModalMarkup(monitor) {
  const status = stateClass(monitor.status);
  const stats = statsFor(monitor);
  const ssl = monitor.ssl;
  const sslText = ssl?.supported ? (ssl.daysRemaining == null ? '已检测' : `${ssl.daysRemaining} 天`) : '未启用';
  const lastPoint = stats.history.at(-1);
  return `<div class="service-modal-heading"><div class="modal-title-wrap"><span class="modal-status-dot ${status}"></span><div><span class="micro-label">服务详细状态 · ${esc(monitor.categoryName || '未分类')}</span><h2>${esc(monitor.name || '未命名服务')}</h2><p>${esc(monitor.url || '未设置地址')}</p><div class="modal-chip-row"><span>${esc(typeLabel[monitor.type] || monitor.type || '服务')}</span><span>${esc(monitor.method || 'GET')}</span><span>${monitor.expectedStatus ? `期望 ${esc(monitor.expectedStatus)}` : '等待配置'}</span></div></div></div><button class="modal-close" type="button" data-modal-close aria-label="关闭详情">×</button></div><div class="detail-status-banner ${status}"><div><span>当前状态</span><strong>${esc(stateLabel[status])}</strong><small>最近 ${stats.total || 0} 次检查 · ${esc(fmtDate(lastPoint?.checkedAt || monitor.checkedAt))}</small></div><div class="detail-availability"><strong>${esc(stats.availability)}${stats.availability === '—' ? '' : '%'}</strong><span>检查成功率</span></div></div><section class="detail-panel"><div class="detail-panel-heading"><div><span class="micro-label">响应时间</span><h3>最近检查趋势</h3></div><span class="detail-panel-note">${stats.total ? `最近 ${stats.total} 次` : '等待数据'}</span></div><div class="detail-chart-wrap">${responseChartMarkup(stats.history)}</div><div class="detail-stat-grid"><div><strong>${stats.average ? `${stats.average}ms` : '—'}</strong><span>平均响应时间</span></div><div><strong>${stats.maximum ? `${stats.maximum}ms` : '—'}</strong><span>最大响应时间</span></div><div><strong>${stats.minimum ? `${stats.minimum}ms` : '—'}</strong><span>最小响应时间</span></div></div></section><section class="detail-panel"><div class="detail-panel-heading"><div><span class="micro-label">运行记录</span><h3>最近 ${stats.history.length || 0} 次检查</h3></div><span class="detail-panel-note">绿色为正常 · 红色为异常</span></div><div class="detail-history-large">${historyCells(stats.history, 60)}</div></section><div class="detail-two-columns"><section class="detail-panel detail-info-panel"><div class="detail-panel-heading"><div><span class="micro-label">检查配置</span><h3>服务信息</h3></div></div><dl class="detail-info-list"><div><dt>检查类型</dt><dd>${esc(typeLabel[monitor.type] || monitor.type || '服务')} · ${esc(monitor.method || 'GET')}</dd></div><div><dt>期望状态码</dt><dd>${esc(monitor.expectedStatus || '—')}</dd></div><div><dt>最近状态</dt><dd class="${status}">${esc(stateLabel[status])}${monitor.latency ? ` · ${monitor.latency}ms` : ''}</dd></div><div><dt>SSL 证书</dt><dd class="${ssl?.daysRemaining != null && ssl.daysRemaining <= 30 ? 'warn' : ''}">${esc(sslText)}</dd></div><div><dt>备注</dt><dd>${esc(monitor.note || monitor.categoryName || '未分类')}</dd></div></dl></section><section class="detail-panel detail-events-panel"><div class="detail-panel-heading"><div><span class="micro-label">近期事件</span><h3>状态变化</h3></div></div><div class="detail-events">${detailEventMarkup(monitor)}</div></section></div>`;
}

function openServiceModal(monitor) {
  const modal = $('#serviceModal');
  const content = $('#serviceModalContent');
  if (!modal || !content || !monitor) return;
  activeMonitorId = monitor.id;
  content.innerHTML = monitorModalMarkup(monitor);
  content.dataset.checkedAt = monitor.checkedAt || '';
  modal.querySelector('.service-modal').scrollTop = 0;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => modal.classList.add('is-open'));
  document.body.classList.add('modal-open');
  content.querySelector('[data-modal-close]')?.focus({ preventScroll: true });
}

function showPointerFeedback(event) {
  if (!event || (event.button != null && event.button !== 0)) return;
  if (event.pointerType === 'touch' || document.body.classList.contains('is-loading')) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  while (document.querySelectorAll('.pointer-card-feedback').length >= 3) document.querySelector('.pointer-card-feedback').remove();
  const effect = document.createElement('span');
  effect.className = 'pointer-card-feedback';
  effect.setAttribute('aria-hidden', 'true');
  effect.style.left = `${event.clientX}px`;
  effect.style.top = `${event.clientY}px`;
  const count = 6;
  const phase = Math.random() * Math.PI * 2;
  for (let index = 0; index < count; index += 1) {
    const card = document.createElement('i');
    const angle = phase + index * Math.PI * 2 / count;
    const distance = 65 + Math.random() * 55;
    card.style.setProperty('--card-x', `${Math.cos(angle) * distance}px`);
    card.style.setProperty('--card-y', `${Math.sin(angle) * distance}px`);
    card.style.setProperty('--card-turn', `${Math.round(Math.random() * 180 - 90)}deg`);
    card.style.setProperty('--card-tilt', `${Math.round(Math.random() * 40 - 20)}deg`);
    effect.append(card);
  }
  document.body.append(effect);
  effect.addEventListener('animationend', () => effect.remove(), { once: true });
  window.setTimeout(() => effect.remove(), 900);
}

function showCardPress(card, event) {
  if (!card || !event) return;
  const rect = card.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const diameter = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y)) * 2;
  card.querySelectorAll('.card-ripple').forEach((ripple) => ripple.remove());
  const ripple = document.createElement('span');
  ripple.className = 'card-ripple';
  ripple.setAttribute('aria-hidden', 'true');
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  ripple.style.width = `${diameter}px`;
  ripple.style.height = `${diameter}px`;
  card.append(ripple);
  card.classList.add('card-press');
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  window.setTimeout(() => ripple.remove(), 600);
  window.setTimeout(() => card.classList.remove('card-press'), 190);
}

function closeServiceModal() {
  const modal = $('#serviceModal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  window.setTimeout(() => { if (!modal.classList.contains('is-open')) modal.hidden = true; }, 220);
  activeMonitorId = '';
}

function serviceCardMarkup(monitor, index) {
  const status = stateClass(monitor.status);
  const lastPoint = (monitor.history || []).at(-1);
  const ssl = monitor.ssl;
  const sslText = ssl?.supported ? (ssl.daysRemaining == null ? 'SSL 已检测' : `SSL ${ssl.daysRemaining} 天`) : '';
  const destination = monitor.type === 'tcp' ? '' : `<a class="service-open" href="${esc(monitor.url)}" target="_blank" rel="noreferrer" aria-label="打开 ${esc(monitor.name)}">↗</a>`;
  return `<article class="service-card glass" data-monitor-id="${esc(monitor.id)}" data-category-id="${esc(monitor.categoryId || '')}" data-state="${status}" role="button" tabindex="0" aria-label="查看 ${esc(monitor.name || '服务')} 详细状态" style="--delay:${Math.min(index, 12) * 45}ms"><div class="service-card-main"><div class="service-card-head"><span class="service-index">${String(index + 1).padStart(2, '0')}</span><span class="service-type">${esc(typeLabel[monitor.type] || monitor.type || '服务')}</span><span class="status-dot ${status}"></span></div><div class="service-card-title"><h3>${esc(monitor.name || '未命名服务')}</h3>${destination}</div><p class="service-url" title="${esc(monitor.url)}">${esc(monitor.url)}</p><div class="service-meta-row"><span class="status-label ${status}">${stateLabel[status]}</span><span class="service-latency">${monitor.latency ? `${monitor.latency}ms` : '—'}</span><span class="service-checked">${lastPoint?.checkedAt ? fmtTime(lastPoint.checkedAt) : '未检查'}</span></div><div class="service-history" aria-label="最近状态记录">${historyCells(monitor.history, 60)}</div><div class="service-card-foot"><span>${esc(monitor.note || monitor.categoryName || '未分类')}</span><span class="ssl-note ${ssl?.daysRemaining != null && ssl.daysRemaining <= 30 ? 'warn' : ''}">${esc(sslText)}</span></div></div></article>`;
}

function updateServiceCard(card, monitor) {
  const status = stateClass(monitor.status);
  const lastPoint = (monitor.history || []).at(-1);
  card.dataset.state = status;
  card.querySelector('.status-dot')?.classList.remove('up', 'down', 'unknown');
  card.querySelector('.status-dot')?.classList.add(status);
  const label = card.querySelector('.status-label');
  if (label) { label.className = `status-label ${status}`; label.textContent = stateLabel[status]; }
  const latency = card.querySelector('.service-latency');
  if (latency) latency.textContent = monitor.latency ? `${monitor.latency}ms` : '—';
  const checked = card.querySelector('.service-checked');
  if (checked) checked.textContent = lastPoint?.checkedAt ? fmtTime(lastPoint.checkedAt) : '未检查';
  const history = card.querySelector('.service-history');
  if (history) history.innerHTML = historyCells(monitor.history, 60);
  card.dataset.state = status;
}

function applyCategoryVisibility() {
  document.querySelectorAll('.service-group').forEach((group) => {
    const hasCard = Boolean(group.querySelector('.service-card'));
    group.hidden = (activeCategory === 'all' && !hasCard) || (activeCategory !== 'all' && group.dataset.categoryId !== activeCategory);
  });
}

function renderCategoryTabs(data) {
  const target = $('#categoryTabs');
  if (!target) return;
  const categories = data.categories || [];
  if (activeCategory !== 'all' && !categories.some((category) => category.id === activeCategory)) activeCategory = 'all';
  target.innerHTML = `<button class="category-tab ${activeCategory === 'all' ? 'active' : ''}" data-category="all">全部服务 <em>${categories.reduce((sum, category) => sum + category.monitors.length, 0)}</em></button>${categories.map((category) => `<button class="category-tab ${activeCategory === category.id ? 'active' : ''}" data-category="${esc(category.id)}">${esc(category.name)} <em>${category.monitors.length}</em></button>`).join('')}`;
  target.querySelectorAll('.category-tab').forEach((button) => button.addEventListener('click', () => { activeCategory = button.dataset.category; target.querySelectorAll('.category-tab').forEach((item) => item.classList.toggle('active', item === button)); applyCategoryVisibility(); }));
}

function renderServices(data, monitors) {
  const target = $('#serviceGroups');
  if (!target) return;
  const categories = data.categories || [];
  const signature = categories.map((category) => `${category.id}:${(category.monitors || []).map((monitor) => `${monitor.id}:${monitor.name}`).join(',')}`).join('|');
  if (!servicesRendered || target.dataset.signature !== signature) {
    let index = 0;
    target.innerHTML = categories.map((category) => {
      const items = category.monitors || [];
      return `<section class="service-group" data-category-id="${esc(category.id)}"><div class="group-heading"><div><span class="micro-label">服务分类</span><h3>${esc(category.name)}</h3></div><span>${items.length} 项</span></div>${items.length ? `<div class="service-grid">${items.map((monitor) => serviceCardMarkup({ ...monitor, categoryName: category.name, categoryId: category.id }, index++)).join('')}</div>` : '<div class="category-empty glass"><span>◌</span><strong>这个分类还没有服务</strong><p>可以在管理后台添加一个网站、接口或 TCP 服务。</p></div>'}</section>`;
    }).join('') || '<div class="empty-state glass"><span>◌</span><strong>还没有监控服务</strong><p>监控服务尚未配置，状态页会在后台完成设置后自动显示。</p></div>';
    target.dataset.signature = signature;
    servicesRendered = true;
  } else {
    monitors.forEach((monitor) => {
      const card = [...target.querySelectorAll('.service-card')].find((item) => item.dataset.monitorId === monitor.id);
      if (card) updateServiceCard(card, monitor);
    });
  }
  applyCategoryVisibility();
}

function renderEvents(data) {
  const target = $('#incidentList');
  if (!target) return;
  const incidents = data.incidents || [];
  const totalPages = Math.max(1, Math.ceil(incidents.length / EVENTS_PAGE_SIZE));
  eventsPage = Math.min(eventsPage, totalPages);
  const start = (eventsPage - 1) * EVENTS_PAGE_SIZE;
  const pageItems = incidents.slice(start, start + EVENTS_PAGE_SIZE);
  const rows = pageItems.map((incident) => {
    const copy = eventCopy(incident);
    const duration = incidentDuration(incident);
    return `<article class="event-row ${incident.status === 'up' ? 'event-up' : 'event-down'}"><div class="event-badge">${incident.status === 'up' ? '↑' : '↓'}</div><div class="event-content"><div class="event-title-line"><strong>${esc(copy.title)}</strong><span>${esc(incident.monitorName || '服务')}</span></div><p class="event-reason">${esc(copy.reason)}</p><p class="event-detail">详情：${esc(copy.detail)} · 故障持续：${esc(duration)}</p><small>${fmtTime(incident.createdAt)}${incident.resolvedAt ? ` · 恢复于 ${fmtTime(incident.resolvedAt)}` : incident.status === 'down' ? ' · 当前仍在持续' : ''}</small></div></article>`;
  }).join('');
  const pagination = incidents.length > EVENTS_PAGE_SIZE ? `<div class="events-pagination"><button type="button" data-events-page="prev" ${eventsPage <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${eventsPage} / ${totalPages} 页 · 共 ${incidents.length} 条</span><button type="button" data-events-page="next" ${eventsPage >= totalPages ? 'disabled' : ''}>下一页</button></div>` : '';
  target.innerHTML = rows || '<div class="empty-events">暂无状态变化记录，服务们目前都很乖。</div>';
  if (pagination) {
    target.insertAdjacentHTML('beforeend', pagination);
    target.querySelectorAll('[data-events-page]').forEach((button) => button.addEventListener('click', () => {
      eventsPage += button.dataset.eventsPage === 'next' ? 1 : -1;
      renderEvents(latestData || { incidents: [] });
    }));
  }
}

function renderMetrics(metrics) {
  if (!metrics) return;
  const memory = metrics.memory || {};
  const disk = metrics.disk || {};
  if ($('#serverPlatform')) $('#serverPlatform').textContent = `${metrics.platform || '未知系统'} · ${metrics.cpuCount || '—'} 核`;
  if ($('#memoryPct')) $('#memoryPct').textContent = `${memory.usedPercent ?? 0}% · ${formatBytes(memory.used)}`;
  if ($('#memoryBar')) $('#memoryBar').style.width = `${Math.min(100, Math.max(0, memory.usedPercent || 0))}%`;
  if ($('#diskPct')) $('#diskPct').textContent = disk.total ? `${disk.usedPercent}% · ${formatBytes(disk.used)}` : '不可用';
  if ($('#diskBar')) $('#diskBar').style.width = `${Math.min(100, Math.max(0, disk.usedPercent || 0))}%`;
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function renderDomains(domains = []) {
  const target = $('#domainList');
  if (!target) return;
  target.innerHTML = domains.length ? domains.map((domain) => {
    const days = domain.daysRemaining;
    const level = days == null ? '' : days <= 7 ? 'danger' : days <= 30 ? 'warn' : '';
    return `<div class="domain-item"><div><strong>${esc(domain.domain)}</strong><small>${domain.expiryDate ? `到期 ${esc(domain.expiryDate)}` : '未设置到期日'}</small></div><b class="${level}">${days == null ? '待补充' : days < 0 ? '已过期' : `${days} 天`}</b></div>`;
  }).join('') : '<span class="muted">暂无域名记录 · 可在管理后台建立台账</span>';
}

function render(data, metrics) {
  latestData = data;
  const settings = data.settings || {};
  const monitors = flattenMonitors(data);
  document.title = `${settings.siteName || 'Status姬'} · 服务状态`;
  if ($('#siteName')) $('#siteName').textContent = settings.siteName || 'Status姬';
  if ($('#siteDescription')) $('#siteDescription').textContent = settings.siteDescription || '网站、接口与服务器运行情况';
  if ($('#refreshMinutes')) $('#refreshMinutes').textContent = Math.max(1, Math.round((settings.refreshSeconds || 300) / 60));
  if ($('#announcementMirror')) $('#announcementMirror').textContent = settings.announcement || '监控系统会在服务状态变化时记录事件并发送通知。';
  if ($('#footerBrand')) $('#footerBrand').textContent = settings.siteName || 'Status姬';
  if ($('#footerTime')) $('#footerTime').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  document.documentElement.style.setProperty('--accent', settings.accentColor || '#7197db');
  loadRandomBackground(settings);
  renderOverall(data, monitors);
  renderCategoryTabs(data);
  renderServices(data, monitors);
  renderEvents(data);
  renderMetrics(metrics);
  renderDomains(data.domains || []);
  setupSearch();
  if (activeMonitorId) {
    const activeMonitor = monitors.find((monitor) => monitor.id === activeMonitorId);
    const content = $('#serviceModalContent');
    if (activeMonitor && !$('#serviceModal')?.hidden && content.dataset.checkedAt !== (activeMonitor.checkedAt || '')) {
      const scroller = $('#serviceModal .service-modal');
      const scrollTop = scroller.scrollTop;
      const closeFocused = content.querySelector('[data-modal-close]') === document.activeElement;
      content.innerHTML = monitorModalMarkup(activeMonitor);
      content.dataset.checkedAt = activeMonitor.checkedAt || '';
      scroller.scrollTop = scrollTop;
      if (closeFocused) content.querySelector('[data-modal-close]').focus({ preventScroll: true });
    }
  }
}

function setupSearch() {
  const strip = $('.search-strip');
  if (!strip || searchBound) return;
  searchBound = true;
  strip.setAttribute('role', 'search');
  strip.innerHTML = '<div class="search-orb"><svg><use href="#i-search"></use></svg></div><input id="serviceSearch" type="search" placeholder="搜索服务名称、地址或状态…" autocomplete="off"><kbd>Ctrl K</kbd><b>搜索</b>';
  const input = $('#serviceSearch');
  const apply = () => {
    const query = input.value.trim().toLowerCase();
    document.querySelectorAll('.service-card').forEach((card) => { card.hidden = Boolean(query) && !card.textContent.toLowerCase().includes(query); });
    document.querySelectorAll('.service-group').forEach((group) => {
      const hasVisibleCard = Boolean(group.querySelector('.service-card:not([hidden])'));
      group.hidden = (activeCategory === 'all' && !hasVisibleCard) || (activeCategory !== 'all' && group.dataset.categoryId !== activeCategory) || (Boolean(query) && !hasVisibleCard);
    });
  };
  input.addEventListener('input', apply);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.focus(); input.select(); }
  });
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.top-tools [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const services = $('#services');
  const events = $('#eventsSection');
  const about = $('#aboutSection');
  const categoryMeta = $('#categoryTabs')?.closest('.section-meta');
  if (services) services.hidden = view !== 'services';
  if (events) events.hidden = view !== 'events';
  if (about) about.hidden = view !== 'about';
  if (categoryMeta) categoryMeta.hidden = view !== 'services';
  document.body.dataset.view = view;
  document.body.classList.remove('view-changing');
}

function setupViewTabs() {
  document.querySelectorAll('.top-tools [data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  setView('services');
}

function setupCardDetails() {
  $('#serviceGroups')?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('a')) return;
    showCardPress(event.target.closest('.service-card'), event);
  }, { passive: true });
  $('#serviceGroups')?.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    const card = event.target.closest('.service-card');
    if (!card) return;
    const monitor = flattenMonitors(latestData || {}).find((item) => item.id === card.dataset.monitorId);
    if (monitor) openServiceModal(monitor);
  });
  $('#serviceGroups')?.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('a')) return;
    const card = event.target.closest('.service-card');
    if (!card) return;
    event.preventDefault();
    const monitor = flattenMonitors(latestData || {}).find((item) => item.id === card.dataset.monitorId);
    if (monitor) openServiceModal(monitor);
  });
}

function setupPointerFeedback() {
  document.addEventListener('pointerdown', showPointerFeedback, { passive: true });
}

function setupModal() {
  const modal = $('#serviceModal');
  if (!modal) return;
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('[data-modal-close]')) closeServiceModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeServiceModal();
  });
}

function setupDecorations() {
  let saved = 'snow';
  try { saved = DECORATIONS.includes(localStorage.getItem('pulse-decoration')) ? localStorage.getItem('pulse-decoration') : 'snow'; } catch { /* localStorage may be disabled */ }
  const canvas = $('#decorationCanvas');
  const engine = canvas && window.DecorationEngine ? new window.DecorationEngine(canvas) : null;
  window.pulseDecorationEngine = engine;
  const apply = (name) => {
    document.body.classList.remove(...DECORATIONS.map((item) => `decor-${item}`));
    document.body.classList.add(`decor-${name}`);
    document.documentElement.dataset.decor = name;
    document.querySelectorAll('.decor-option').forEach((button) => button.classList.toggle('active', button.dataset.decor === name));
    try { localStorage.setItem('pulse-decoration', name); } catch { /* ignore storage failures */ }
    engine?.setMode(name);
  };
  const switchDecor = (name) => {
    refreshDecoration(() => apply(name));
  };
  apply(saved);
  document.querySelectorAll('.decor-option').forEach((button) => button.addEventListener('click', () => switchDecor(button.dataset.decor)));
  $('#decorToggle')?.addEventListener('click', () => switchDecor(DECORATIONS[(DECORATIONS.indexOf(document.documentElement.dataset.decor) + 1) % DECORATIONS.length]));
}

async function load() {
  if (loadingPromise) return loadingPromise;
  document.body.classList.add('data-refreshing');
  loadingPromise = (async () => {
    try {
      const [publicResponse, metricsResponse] = await Promise.all([fetch('/api/public', { signal: AbortSignal.timeout(12000), cache: 'no-store' }), fetch('/api/metrics', { signal: AbortSignal.timeout(12000), cache: 'no-store' }).catch(() => null)]);
      if (!publicResponse.ok) throw new Error('状态接口暂时不可用');
      const data = await publicResponse.json();
      const metrics = metricsResponse?.ok ? await metricsResponse.json() : null;
      render(data, metrics);
    } catch (error) {
      if ($('#overallTitle')) $('#overallTitle').textContent = '状态暂时无法获取';
      if ($('#overallSub')) $('#overallSub').textContent = error.message || '请稍后刷新页面';
    } finally {
      window.setTimeout(() => document.body.classList.remove('data-refreshing'), 260);
      loadingPromise = null;
      scheduleRefreshFetch();
    }
  })();
  return loadingPromise;
}

function scheduleRefreshFetch() {
  window.clearTimeout(refreshFetchTimer);
  if (schedulerRunning) {
    refreshFetchTimer = window.setTimeout(load, 1500);
    return;
  }
  if (!nextRefreshAt) return;
  const delay = Math.max(1000, nextRefreshAt - Date.now() + 250);
  refreshFetchTimer = window.setTimeout(load, Math.min(delay, 30000));
}

setupDecorations();
setupViewTabs();
setupCardDetails();
setupPointerFeedback();
setupModal();
const initialDataPromise = load();
finishInitialLoad(initialDataPromise);
window.setInterval(() => { if (!loadingPromise) load(); }, 30000);
window.setInterval(updateCountdown, 1000);
