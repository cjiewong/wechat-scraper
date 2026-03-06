function createElectronApiFallback() {
  try {
    // eslint-disable-next-line no-undef
    const { ipcRenderer } = require('electron');
    return {
      openMpPlatform: () => ipcRenderer.invoke('open-mp-platform'),
      startQrLogin: () => ipcRenderer.invoke('start-qr-login'),
      loadSession: () => ipcRenderer.invoke('load-session'),
      saveSession: (session) => ipcRenderer.invoke('save-session', session),
      clearSession: () => ipcRenderer.invoke('clear-session'),
      testSession: (session) => ipcRenderer.invoke('test-session', session),
      searchAccounts: (options) => ipcRenderer.invoke('search-accounts', options),
      getArticleList: (options) => ipcRenderer.invoke('get-article-list', options),
      startScraping: (options) => ipcRenderer.invoke('start-scraping', options),
      stopScraping: () => ipcRenderer.invoke('stop-scraping'),
      startFullExport: (options) => ipcRenderer.invoke('start-full-export', options),
      stopFullExport: () => ipcRenderer.invoke('stop-full-export'),
      getFullExportTask: (options) => ipcRenderer.invoke('get-full-export-task', options),
      resumeFullExport: (options) => ipcRenderer.invoke('resume-full-export', options),
      getIncrementalSyncConfig: () => ipcRenderer.invoke('get-incremental-sync-config'),
      saveIncrementalSyncConfig: (configPayload) => ipcRenderer.invoke('save-incremental-sync-config', configPayload),
      addIncrementalTargetFromSelected: (payload) => ipcRenderer.invoke('add-incremental-target-from-selected', payload),
      removeIncrementalTarget: (payload) => ipcRenderer.invoke('remove-incremental-target', payload),
      runIncrementalSyncNow: (payload) => ipcRenderer.invoke('run-incremental-sync-now', payload),
      stopIncrementalSync: () => ipcRenderer.invoke('stop-incremental-sync'),
      selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
      getStats: () => ipcRenderer.invoke('get-stats'),
      onScrapingProgress: (callback) => {
        ipcRenderer.on('scraping-progress', (_event, payload) => callback(payload));
      },
      onStatusUpdate: (callback) => {
        ipcRenderer.on('status-update', (_event, payload) => callback(payload));
      },
      onFullExportProgress: (callback) => {
        ipcRenderer.on('full-export-progress', (_event, payload) => callback(payload));
      },
      onFullExportDone: (callback) => {
        ipcRenderer.on('full-export-done', (_event, payload) => callback(payload));
      },
      onIncrementalSyncProgress: (callback) => {
        ipcRenderer.on('incremental-sync-progress', (_event, payload) => callback(payload));
      },
      onIncrementalSyncDone: (callback) => {
        ipcRenderer.on('incremental-sync-done', (_event, payload) => callback(payload));
      },
      removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
      }
    };
  } catch (error) {
    return null;
  }
}

const electronAPI = window.electronAPI || createElectronApiFallback();

if (!electronAPI) {
  window.alert('应用初始化失败：未建立 Electron IPC 通道，请重启应用。');
  throw new Error('electronAPI is unavailable');
}

const supportsFullExport = Boolean(
  electronAPI.startFullExport &&
  electronAPI.resumeFullExport &&
  electronAPI.getFullExportTask
);
const supportsIncrementalSync = Boolean(
  electronAPI.getIncrementalSyncConfig &&
  electronAPI.saveIncrementalSyncConfig &&
  electronAPI.addIncrementalTargetFromSelected &&
  electronAPI.removeIncrementalTarget &&
  electronAPI.runIncrementalSyncNow &&
  electronAPI.stopIncrementalSync
);

const tokenInput = document.getElementById('tokenInput');
const cookieInput = document.getElementById('cookieInput');
const userAgentInput = document.getElementById('userAgentInput');
const qrLoginBtn = document.getElementById('qrLoginBtn');
const saveSessionBtn = document.getElementById('saveSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
const testSessionBtn = document.getElementById('testSessionBtn');
const openMpBtn = document.getElementById('openMpBtn');
const sessionBadge = document.getElementById('sessionBadge');

const accountKeyword = document.getElementById('accountKeyword');
const searchBtn = document.getElementById('searchBtn');
const accountList = document.getElementById('accountList');

const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const maxPages = document.getElementById('maxPages');
const pageSize = document.getElementById('pageSize');
const loadArticlesBtn = document.getElementById('loadArticlesBtn');
const clearArticlesBtn = document.getElementById('clearArticlesBtn');
const articleCount = document.getElementById('articleCount');
const articleTableBody = document.getElementById('articleTableBody');
const selectAllBtn = document.getElementById('selectAllBtn');
const clearSelectionBtn = document.getElementById('clearSelectionBtn');
const selectedCount = document.getElementById('selectedCount');

const outputDir = document.getElementById('outputDir');
const selectDirBtn = document.getElementById('selectDirBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const fullPageSize = document.getElementById('fullPageSize');
const startFullExportBtn = document.getElementById('startFullExportBtn');
const resumeFullExportBtn = document.getElementById('resumeFullExportBtn');
const fullExportSnapshot = document.getElementById('fullExportSnapshot');
const fullExportModeBadge = document.getElementById('fullExportModeBadge');
const incrementalEnabled = document.getElementById('incrementalEnabled');
const incrementalDailyTime = document.getElementById('incrementalDailyTime');
const incrementalDays = document.getElementById('incrementalDays');
const incrementalRuntimePageSize = document.getElementById('incrementalRuntimePageSize');
const incrementalRuntimeMaxPages = document.getElementById('incrementalRuntimeMaxPages');
const saveIncrementalConfigBtn = document.getElementById('saveIncrementalConfigBtn');
const addIncrementalTargetBtn = document.getElementById('addIncrementalTargetBtn');
const runIncrementalNowBtn = document.getElementById('runIncrementalNowBtn');
const stopIncrementalBtn = document.getElementById('stopIncrementalBtn');
const incrementalTimezone = document.getElementById('incrementalTimezone');
const incrementalModeBadge = document.getElementById('incrementalModeBadge');
const incrementalSnapshot = document.getElementById('incrementalSnapshot');
const incrementalTargetTableBody = document.getElementById('incrementalTargetTableBody');

const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');

const statTotal = document.getElementById('statTotal');
const statScraped = document.getElementById('statScraped');
const statPaid = document.getElementById('statPaid');
const statError = document.getElementById('statError');

const logList = document.getElementById('logList');
const statusText = document.getElementById('statusText');

const state = {
  accounts: [],
  selectedAccount: null,
  articles: [],
  selectedArticleIds: new Set(),
  isScraping: false,
  scrapeMode: null,
  activeFullTaskId: '',
  fullExportTask: null,
  lastFullProgressLogAt: 0,
  incrementalConfig: null,
  isIncrementalRunning: false,
  lastIncrementalProgressLogAt: 0
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(dateValue) {
  if (!dateValue) {
    return '-';
  }

  const asNumber = Number(dateValue);
  const date = Number.isFinite(asNumber) && asNumber > 100000
    ? new Date(asNumber * 1000)
    : new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return String(dateValue);
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

function setBadge(el, label, type = 'muted') {
  el.textContent = label;
  el.className = `badge badge-${type}`;
}

function appendLog(message, level = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.textContent = `[${time}] [${level.toUpperCase()}] ${message}`;
  logList.appendChild(line);

  while (logList.children.length > 200) {
    logList.removeChild(logList.firstChild);
  }

  logList.scrollTop = logList.scrollHeight;
}

function setStatus(message, level = 'info') {
  statusText.textContent = message;
  appendLog(message, level);
}

function setStatusTextOnly(message) {
  statusText.textContent = message;
}

function selectedFormat() {
  const selected = document.querySelector('input[name="format"]:checked');
  return selected ? selected.value : 'md';
}

function taskStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'running') {
    return '进行中';
  }
  if (value === 'paused') {
    return '已暂停';
  }
  if (value === 'completed') {
    return '已完成';
  }
  if (value === 'failed') {
    return '失败';
  }
  if (value === 'pending') {
    return '等待中';
  }
  return '未启动';
}

function taskStatusBadgeType(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'running' || value === 'completed') {
    return 'success';
  }
  if (value === 'failed') {
    return 'error';
  }
  return 'muted';
}

function renderFullExportTask(task) {
  state.fullExportTask = task || null;
  state.activeFullTaskId = task?.taskId || '';

  if (!task) {
    setBadge(fullExportModeBadge, '未启动', 'muted');
    fullExportSnapshot.textContent = state.selectedAccount
      ? '当前公众号暂无历史任务，点击“开始全量导出”后会自动创建任务记录'
      : '选择公众号后可查看历史任务快照';
    updateActionState();
    return;
  }

  const stats = task.stats || {};
  const cursor = task.cursor || {};
  const statusLabel = taskStatusLabel(task.status);
  setBadge(fullExportModeBadge, statusLabel, taskStatusBadgeType(task.status));

  const totalExpected = Number(stats.totalExpected || 0);
  const processed = Number(stats.processedArticles || 0);
  const exported = Number(stats.exported || 0);
  const skippedExisting = Number(stats.skippedExisting || 0);
  const skippedPaid = Number(stats.skippedPaid || 0);
  const failed = Number(stats.failed || 0);
  const failureCount = Number(task.failureCount || 0);

  fullExportSnapshot.textContent = [
    `任务ID：${task.taskId || '-'}`,
    `状态：${statusLabel}`,
    `游标：begin=${Number(cursor.begin || 0)} / page=${Number(cursor.pageIndex || 0) + 1} / size=${Number(cursor.pageSize || 0)}`,
    `统计：预计 ${totalExpected || '未知'}，已处理 ${processed}，成功 ${exported}，已存在 ${skippedExisting}，付费 ${skippedPaid}，失败 ${failed}`,
    `更新时间：${task.updatedAt ? formatDate(task.updatedAt) : '-'}`,
    `失败记录缓存：${failureCount} 条`,
    task.lastError ? `最近错误：${task.lastError}` : ''
  ].filter(Boolean).join('\n');

  updateActionState();
}

async function refreshFullExportTask() {
  if (!supportsFullExport || !state.selectedAccount?.fakeid) {
    renderFullExportTask(null);
    return;
  }

  try {
    const result = await electronAPI.getFullExportTask({
      fakeid: state.selectedAccount.fakeid
    });
    if (!result.success) {
      throw new Error(result.error || '读取任务失败');
    }
    renderFullExportTask(result.exists ? result.task : null);
  } catch (error) {
    renderFullExportTask(null);
    appendLog(`读取历史任务失败：${error.message}`, 'warn');
  }
}

function incrementalStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'running') {
    return '执行中';
  }
  if (value === 'success') {
    return '成功';
  }
  if (value === 'partial_failed') {
    return '部分失败';
  }
  if (value === 'failed') {
    return '失败';
  }
  if (value === 'skipped_conflict') {
    return '冲突跳过';
  }
  if (value === 'never') {
    return '未执行';
  }
  return '待机';
}

function incrementalStatusBadgeType(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'success' || value === 'running') {
    return 'success';
  }
  if (value === 'partial_failed' || value === 'skipped_conflict') {
    return 'warn';
  }
  if (value === 'failed') {
    return 'error';
  }
  return 'muted';
}

function collectIncrementalConfigFromForm() {
  const current = state.incrementalConfig || {};
  const scheduler = current.scheduler || {};
  const runtime = current.runtime || {};
  return {
    version: Number(current.version || 1),
    scheduler: {
      ...scheduler,
      enabled: Boolean(incrementalEnabled.checked),
      dailyTime: String(incrementalDailyTime.value || '08:30')
    },
    runtime: {
      ...runtime,
      incrementalDays: Math.max(1, Number(incrementalDays.value) || 7),
      pageSize: Math.max(1, Number(incrementalRuntimePageSize.value) || 10),
      maxPagesPerRun: Math.max(1, Number(incrementalRuntimeMaxPages.value) || 20)
    },
    targets: Array.isArray(current.targets) ? current.targets.map((item) => ({ ...item })) : []
  };
}

function renderIncrementalTargets() {
  const configPayload = state.incrementalConfig || {};
  const targets = Array.isArray(configPayload.targets) ? configPayload.targets : [];

  if (!targets.length) {
    incrementalTargetTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">暂无增量同步目标</td></tr>';
    return;
  }

  incrementalTargetTableBody.innerHTML = targets.map((target) => {
    const summary = target.lastSummary || {};
    const summaryText = `抓取 ${Number(summary.fetched || 0)} / 成功 ${Number(summary.exported || 0)} / 失败 ${Number(summary.failed || 0)}`;
    return `
      <tr data-target-id="${escapeHtml(target.id)}">
        <td><input class="inc-target-enabled" type="checkbox" ${target.enabled ? 'checked' : ''}></td>
        <td>
          <div class="inc-target-name">${escapeHtml(target.accountName)}</div>
          <div class="inc-target-id">${escapeHtml(target.fakeid)}</div>
        </td>
        <td>
          <div class="inc-target-path">${escapeHtml(target.outputDir || '-')}</div>
          <div class="inc-target-format">格式：${escapeHtml((target.format || 'md').toUpperCase())}</div>
        </td>
        <td>
          ${escapeHtml(incrementalStatusLabel(target.lastStatus))}
          <br>
          <span class="inc-target-meta">${escapeHtml(summaryText)}</span>
        </td>
        <td>
          <div class="inc-target-actions">
            <button class="btn btn-text inc-target-toggle-format">${escapeHtml((target.format || 'md') === 'pdf' ? '改MD' : '改PDF')}</button>
            <button class="btn btn-text inc-target-remove">删除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  incrementalTargetTableBody.querySelectorAll('tr[data-target-id]').forEach((row) => {
    const targetId = row.dataset.targetId;
    const enabledCheckbox = row.querySelector('.inc-target-enabled');
    const removeBtn = row.querySelector('.inc-target-remove');
    const toggleFormatBtn = row.querySelector('.inc-target-toggle-format');

    enabledCheckbox?.addEventListener('change', async () => {
      const configPayload = state.incrementalConfig || {};
      const targets = Array.isArray(configPayload.targets) ? configPayload.targets : [];
      const nextTargets = targets.map((item) => {
        if (item.id !== targetId) {
          return item;
        }
        return {
          ...item,
          enabled: Boolean(enabledCheckbox.checked)
        };
      });
      await saveIncrementalConfig({
        ...configPayload,
        targets: nextTargets
      }, false);
    });

    removeBtn?.addEventListener('click', async () => {
      const result = await electronAPI.removeIncrementalTarget({ id: targetId });
      if (!result.success) {
        setStatus(`删除增量目标失败：${result.error}`, 'error');
        return;
      }
      state.incrementalConfig = result.config || null;
      renderIncrementalConfig();
      setStatus('已删除增量同步目标', 'success');
    });

    toggleFormatBtn?.addEventListener('click', async () => {
      const configPayload = state.incrementalConfig || {};
      const targets = Array.isArray(configPayload.targets) ? configPayload.targets : [];
      const nextTargets = targets.map((item) => {
        if (item.id !== targetId) {
          return item;
        }
        return {
          ...item,
          format: String(item.format || 'md').toLowerCase() === 'pdf' ? 'md' : 'pdf'
        };
      });
      await saveIncrementalConfig({
        ...configPayload,
        targets: nextTargets
      }, false);
    });
  });
}

function renderIncrementalConfig() {
  const configPayload = state.incrementalConfig;
  if (!configPayload) {
    setBadge(incrementalModeBadge, '未配置', 'muted');
    incrementalSnapshot.textContent = '尚未加载增量同步配置';
    renderIncrementalTargets();
    updateActionState();
    return;
  }

  const scheduler = configPayload.scheduler || {};
  const runtime = configPayload.runtime || {};
  incrementalEnabled.checked = Boolean(scheduler.enabled);
  incrementalDailyTime.value = String(scheduler.dailyTime || '08:30');
  incrementalTimezone.textContent = String(scheduler.timezone || '-');
  incrementalDays.value = String(Number(runtime.incrementalDays || 7));
  incrementalRuntimePageSize.value = String(Number(runtime.pageSize || 10));
  incrementalRuntimeMaxPages.value = String(Number(runtime.maxPagesPerRun || 20));

  const schedulerStatus = state.isIncrementalRunning
    ? 'running'
    : String(scheduler.lastStatus || 'idle');
  setBadge(
    incrementalModeBadge,
    incrementalStatusLabel(schedulerStatus),
    incrementalStatusBadgeType(schedulerStatus)
  );

  const enabledTargets = (configPayload.targets || []).filter((item) => item.enabled).length;
  incrementalSnapshot.textContent = [
    `调度：${scheduler.enabled ? '已启用' : '已关闭'} / 每日 ${scheduler.dailyTime || '08:30'} / 时区 ${scheduler.timezone || '-'}`,
    `目标：共 ${(configPayload.targets || []).length} 个，启用 ${enabledTargets} 个`,
    `运行参数：窗口 ${Number(runtime.incrementalDays || 7)} 天，pageSize ${Number(runtime.pageSize || 10)}，maxPages ${Number(runtime.maxPagesPerRun || 20)}`,
    `上次触发日期：${scheduler.lastTriggeredDate || '-'}`,
    `上次执行：${scheduler.lastRunAt ? formatDate(scheduler.lastRunAt) : '-'}`,
    `上次结果：${incrementalStatusLabel(scheduler.lastStatus || 'idle')}`,
    scheduler.lastMessage ? `说明：${scheduler.lastMessage}` : ''
  ].filter(Boolean).join('\n');

  renderIncrementalTargets();
  updateActionState();
}

async function refreshIncrementalConfig() {
  if (!supportsIncrementalSync) {
    state.incrementalConfig = null;
    renderIncrementalConfig();
    return;
  }

  try {
    const result = await electronAPI.getIncrementalSyncConfig();
    if (!result.success) {
      throw new Error(result.error || '读取配置失败');
    }
    state.incrementalConfig = result.config || null;
    renderIncrementalConfig();
  } catch (error) {
    setStatus(`读取增量配置失败：${error.message}`, 'error');
  }
}

async function saveIncrementalConfig(configPayload, withNotice = true) {
  const result = await electronAPI.saveIncrementalSyncConfig(configPayload);
  if (!result.success) {
    setStatus(`保存增量配置失败：${result.error}`, 'error');
    return false;
  }

  state.incrementalConfig = result.config || null;
  renderIncrementalConfig();
  if (withNotice) {
    setStatus('增量同步配置已保存', 'success');
  }
  return true;
}

async function saveIncrementalConfigFromForm() {
  const payload = collectIncrementalConfigFromForm();
  await saveIncrementalConfig(payload, true);
}

async function addSelectedAccountToIncrementalTargets() {
  if (!state.selectedAccount?.fakeid) {
    window.alert('请先选择公众号');
    return;
  }
  if (!outputDir.value.trim()) {
    window.alert('请先选择输出目录');
    return;
  }

  const result = await electronAPI.addIncrementalTargetFromSelected({
    fakeid: state.selectedAccount.fakeid,
    accountName: state.selectedAccount.name || state.selectedAccount.fakeid,
    outputDir: outputDir.value.trim(),
    format: selectedFormat()
  });
  if (!result.success) {
    setStatus(`添加增量目标失败：${result.error}`, 'error');
    return;
  }

  state.incrementalConfig = result.config || null;
  renderIncrementalConfig();
  setStatus('已添加当前公众号到增量同步目标', 'success');
}

async function runIncrementalSyncNow() {
  if (!supportsIncrementalSync) {
    return;
  }

  state.isIncrementalRunning = true;
  state.scrapeMode = 'incremental';
  state.isScraping = true;
  state.lastIncrementalProgressLogAt = 0;
  updateActionState();
  renderIncrementalConfig();
  setStatus('正在启动增量同步...');

  const runtimeConfig = collectIncrementalConfigFromForm().runtime;
  try {
    const result = await electronAPI.runIncrementalSyncNow({
      runtime: runtimeConfig
    });
    if (!result.success) {
      throw new Error(result.error || '执行失败');
    }
  } catch (error) {
    state.isIncrementalRunning = false;
    if (state.scrapeMode === 'incremental') {
      state.scrapeMode = null;
    }
    state.isScraping = false;
    updateActionState();
    renderIncrementalConfig();
    setStatus(`启动增量同步失败：${error.message}`, 'error');
  }
}

function updateActionState() {
  const hasOutputDir = outputDir.value.trim().length > 0;
  const canStartManual =
    !state.isScraping &&
    state.selectedArticleIds.size > 0 &&
    hasOutputDir;

  const canStartFull =
    !state.isScraping &&
    Boolean(state.selectedAccount?.fakeid) &&
    hasOutputDir;

  const resumable = ['paused', 'failed', 'running', 'pending'].includes(
    String(state.fullExportTask?.status || '').toLowerCase()
  );
  const canResumeFull =
    !state.isScraping &&
    Boolean(state.selectedAccount?.fakeid) &&
    Boolean(state.fullExportTask?.taskId) &&
    resumable;

  startBtn.disabled = !canStartManual;
  startFullExportBtn.disabled = !supportsFullExport || !canStartFull;
  resumeFullExportBtn.disabled = !supportsFullExport || !canResumeFull;
  const canManageIncremental = supportsIncrementalSync && !state.isScraping;
  const canRunIncremental = supportsIncrementalSync && !state.isScraping;
  const canStopIncremental = supportsIncrementalSync && state.isIncrementalRunning;
  saveIncrementalConfigBtn.disabled = !canManageIncremental;
  addIncrementalTargetBtn.disabled = !canManageIncremental;
  runIncrementalNowBtn.disabled = !canRunIncremental;
  stopIncrementalBtn.disabled = !canStopIncremental;
  stopBtn.disabled = !state.isScraping;
}

function updateStats(stats = {}) {
  statTotal.textContent = stats.total || 0;
  statScraped.textContent = stats.scraped || 0;
  statPaid.textContent = stats.skippedPaid || 0;
  const failedDetailsCount = Array.isArray(stats.failedDetails) ? stats.failedDetails.length : 0;
  const skippedErrorCount = Number(stats.skippedError || 0);
  const fallbackErrorCount = Array.isArray(stats.errors) ? stats.errors.length : 0;
  statError.textContent = Math.max(skippedErrorCount, failedDetailsCount, fallbackErrorCount);
}

function updateProgress(progress = {}) {
  const percentage = progress.percentage || 0;
  progressFill.style.width = `${percentage}%`;
  progressPercent.textContent = `${percentage}%`;
  progressText.textContent = `${progress.current || 0}/${progress.total || 0} ${progress.article || ''}`.trim();
}

function renderAccounts() {
  if (!state.accounts.length) {
    accountList.className = 'account-list empty-state';
    accountList.innerHTML = '没有匹配的公众号';
    updateActionState();
    return;
  }

  accountList.className = 'account-list';
  accountList.innerHTML = state.accounts.map((account) => {
    const activeClass = state.selectedAccount && state.selectedAccount.fakeid === account.fakeid
      ? 'account-item active'
      : 'account-item';
    const hasValidArticleCount =
      account.articleCount !== null &&
      account.articleCount !== undefined &&
      account.articleCount !== '' &&
      Number.isFinite(Number(account.articleCount));

    const articleCountLabel = hasValidArticleCount
      ? Number(account.articleCount)
      : '未知';

    return `
      <div class="${activeClass}" data-fakeid="${escapeHtml(account.fakeid)}">
        <div class="account-name">${escapeHtml(account.name)}</div>
        <div class="account-meta">@${escapeHtml(account.userName || account.alias || '-')}</div>
        <div class="account-meta">文章数（公开计数）：${articleCountLabel} | fakeid：${escapeHtml(account.fakeid || '-')}</div>
      </div>
    `;
  }).join('');

  accountList.querySelectorAll('.account-item').forEach((item) => {
    item.addEventListener('click', () => {
      const fakeid = item.dataset.fakeid;
      state.selectedAccount = state.accounts.find((account) => account.fakeid === fakeid) || null;
      renderAccounts();
      setStatus(`已选择公众号：${state.selectedAccount ? state.selectedAccount.name : '-'}`);
      void refreshFullExportTask();
    });
  });
}

function renderArticles() {
  articleCount.textContent = `${state.articles.length} 篇`;
  selectedCount.textContent = `已选 ${state.selectedArticleIds.size} 篇`;

  if (!state.articles.length) {
    articleTableBody.innerHTML = '<tr><td colspan="3" class="empty-state">暂无文章数据</td></tr>';
    updateActionState();
    return;
  }

  articleTableBody.innerHTML = state.articles.map((article) => {
    const checked = state.selectedArticleIds.has(article.id) ? 'checked' : '';
    return `
      <tr>
        <td><input class="article-check" data-id="${escapeHtml(article.id)}" type="checkbox" ${checked}></td>
        <td>
          <div>${escapeHtml(article.title)}</div>
          <div style="font-size:12px;color:#5e7378;margin-top:4px;">${escapeHtml(article.url || '')}</div>
        </td>
        <td>${escapeHtml(formatDate(article.updateTime || article.date))}</td>
      </tr>
    `;
  }).join('');

  articleTableBody.querySelectorAll('.article-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const id = checkbox.dataset.id;
      if (checkbox.checked) {
        state.selectedArticleIds.add(id);
      } else {
        state.selectedArticleIds.delete(id);
      }
      selectedCount.textContent = `已选 ${state.selectedArticleIds.size} 篇`;
      updateActionState();
    });
  });

  updateActionState();
}

function collectSessionPayload() {
  return {
    token: tokenInput.value.trim(),
    cookie: cookieInput.value.trim(),
    userAgent: userAgentInput.value.trim()
  };
}

async function saveSession() {
  const payload = collectSessionPayload();
  const result = await electronAPI.saveSession(payload);

  if (!result.success) {
    setBadge(sessionBadge, '保存失败', 'error');
    setStatus(`保存会话失败：${result.error}`, 'error');
    return false;
  }

  setBadge(sessionBadge, '已保存', 'success');
  setStatus('会话已保存');
  return true;
}

async function clearSession() {
  const confirmed = window.confirm('确认清空当前登录会话吗？');
  if (!confirmed) {
    return false;
  }

  const result = await electronAPI.clearSession();
  if (!result.success) {
    setStatus(`清空会话失败：${result.error}`, 'error');
    return false;
  }

  tokenInput.value = '';
  cookieInput.value = '';
  userAgentInput.value = result.session?.userAgent || '';
  setBadge(sessionBadge, '会话已清空', 'muted');
  setStatus('登录会话与应用内浏览器 Cookie 已清空');
  return true;
}

async function testSession() {
  const payload = collectSessionPayload();
  const result = await electronAPI.testSession(payload);

  if (!result.success) {
    setBadge(sessionBadge, '无效会话', 'error');
    setStatus(`会话检测失败：${result.error}`, 'error');
    return false;
  }

  setBadge(sessionBadge, '会话有效', 'success');
  setStatus('会话检测通过，可开始搜索公众号', 'success');
  return true;
}

async function searchAccounts() {
  const keyword = accountKeyword.value.trim();
  if (!keyword) {
    window.alert('请输入公众号名称');
    return;
  }

  searchBtn.disabled = true;
  searchBtn.textContent = '搜索中...';

  try {
    const result = await electronAPI.searchAccounts({ keyword, limit: 20, offset: 0 });
    if (!result.success) {
      throw new Error(result.error || '搜索失败');
    }

    state.accounts = result.accounts || [];
    state.selectedAccount = state.accounts.length ? state.accounts[0] : null;
    renderAccounts();
    await refreshFullExportTask();

    setStatus(`搜索完成，匹配到 ${state.accounts.length} 个公众号`);
  } catch (error) {
    setStatus(`搜索公众号失败：${error.message}`, 'error');
    accountList.className = 'account-list empty-state';
    accountList.innerHTML = '搜索失败';
    state.selectedAccount = null;
    renderFullExportTask(null);
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '搜索';
  }
}

async function loadArticles() {
  if (!state.selectedAccount) {
    window.alert('请先选择公众号');
    return;
  }

  loadArticlesBtn.disabled = true;
  loadArticlesBtn.textContent = '加载中...';

  try {
    const result = await electronAPI.getArticleList({
      fakeid: state.selectedAccount.fakeid,
      startDate: startDate.value,
      endDate: endDate.value,
      maxPages: Number(maxPages.value) || 3,
      pageSize: Number(pageSize.value) || 5
    });

    if (!result.success) {
      throw new Error(result.error || '获取文章失败');
    }

    state.articles = result.articles || [];
    state.selectedArticleIds = new Set(state.articles.map((item) => item.id));
    renderArticles();
    setStatus(`已加载 ${state.articles.length} 篇文章，默认全部勾选`);
  } catch (error) {
    setStatus(`加载文章列表失败：${error.message}`, 'error');
  } finally {
    loadArticlesBtn.disabled = false;
    loadArticlesBtn.textContent = '加载文章列表';
  }
}

function updateStatsByFullExport(summary = {}) {
  const total = Number(summary.totalExpected || 0);
  const scraped = Number(summary.exported || 0);
  const skippedPaid = Number(summary.skippedPaid || 0);
  const skippedError = Number(summary.failed || 0);

  updateStats({
    total,
    scraped,
    skippedPaid,
    skippedError
  });
}

async function startFullExport() {
  if (!supportsFullExport) {
    setStatus('当前版本不支持全量导出，请升级应用', 'error');
    return;
  }

  if (state.isScraping) {
    return;
  }

  if (!state.selectedAccount?.fakeid) {
    window.alert('请先选择公众号');
    return;
  }

  if (!outputDir.value.trim()) {
    window.alert('请选择输出目录');
    return;
  }

  const format = selectedFormat();
  const pageSizeValue = Math.max(1, Math.min(20, Number(fullPageSize.value) || 10));
  fullPageSize.value = String(pageSizeValue);
  const accountName = state.selectedAccount.name || state.selectedAccount.fakeid;

  const confirmed = window.confirm(
    `确认开始全量导出“${accountName}”的历史文章吗？\n将按分页流式抓取，可随时暂停并续传。`
  );
  if (!confirmed) {
    return;
  }

  state.isScraping = true;
  state.scrapeMode = 'full';
  state.lastFullProgressLogAt = 0;
  updateActionState();
  updateProgress({ current: 0, total: 0, percentage: 0, article: '' });
  updateStats({ total: 0, scraped: 0, skippedPaid: 0, skippedError: 0 });
  setStatus(`正在启动全量导出：${accountName}`);

  try {
    const result = await electronAPI.startFullExport({
      fakeid: state.selectedAccount.fakeid,
      accountName,
      outputDir: outputDir.value.trim(),
      format,
      pageSize: pageSizeValue,
      resume: false
    });

    if (!result.success) {
      throw new Error(result.error || '启动失败');
    }

    renderFullExportTask(result.task || null);
    setStatus(`全量导出任务已启动：${accountName}`, 'success');
  } catch (error) {
    state.isScraping = false;
    state.scrapeMode = null;
    updateActionState();
    setStatus(`启动全量导出失败：${error.message}`, 'error');
    window.alert(`启动全量导出失败：${error.message}`);
  }
}

async function resumeFullExport() {
  if (!supportsFullExport) {
    setStatus('当前版本不支持全量导出，请升级应用', 'error');
    return;
  }

  if (state.isScraping) {
    return;
  }

  if (!state.selectedAccount?.fakeid) {
    window.alert('请先选择公众号');
    return;
  }

  const taskId = state.fullExportTask?.taskId || state.activeFullTaskId || '';
  if (!taskId) {
    window.alert('当前公众号没有可续跑的历史任务');
    return;
  }

  state.isScraping = true;
  state.scrapeMode = 'full';
  state.lastFullProgressLogAt = 0;
  updateActionState();
  setStatus('正在继续上次全量导出任务...');

  try {
    const result = await electronAPI.resumeFullExport({
      taskId,
      fakeid: state.selectedAccount.fakeid
    });

    if (!result.success) {
      throw new Error(result.error || '续跑失败');
    }

    renderFullExportTask(result.task || null);
    setStatus('已继续上次全量导出任务', 'success');
  } catch (error) {
    state.isScraping = false;
    state.scrapeMode = null;
    updateActionState();
    setStatus(`继续任务失败：${error.message}`, 'error');
    window.alert(`继续任务失败：${error.message}`);
  }
}

async function startExport() {
  if (state.isScraping) {
    return;
  }

  const selected = state.articles.filter((article) => state.selectedArticleIds.has(article.id));
  if (!selected.length) {
    window.alert('请先选择至少一篇文章');
    return;
  }

  if (!outputDir.value.trim()) {
    window.alert('请选择输出目录');
    return;
  }

  const format = selectedFormat();

  const confirmed = window.confirm(
    `确认导出 ${selected.length} 篇文章？\n格式：${format.toUpperCase()}`
  );
  if (!confirmed) {
    return;
  }

  state.isScraping = true;
  state.scrapeMode = 'manual';
  updateActionState();
  updateProgress({ current: 0, total: selected.length, percentage: 0, article: '' });
  updateStats({ total: selected.length, scraped: 0, skippedPaid: 0, skippedError: 0 });
  setStatus(`开始导出 ${selected.length} 篇文章...`);

  try {
    const result = await electronAPI.startScraping({
      articles: selected,
      outputDir: outputDir.value.trim(),
      format
    });

    if (!result.success) {
      throw new Error(result.error || '导出失败');
    }

    updateStats(result.stats);
    setStatus('导出完成', 'success');

    const failedDetails = Array.isArray(result.stats.failedDetails) ? result.stats.failedDetails : [];
    if (failedDetails.length > 0) {
      failedDetails.slice(0, 10).forEach((item, idx) => {
        const title = item.title || '未知文章';
        const reason = item.error || item.reason || '未知错误';
        setStatus(`失败 #${idx + 1}：${title} -> ${reason}`, 'error');
      });
    }

    const failedSummary = failedDetails.length > 0
      ? `\n失败原因（最多显示5条）：\n${failedDetails
        .slice(0, 5)
        .map((item, idx) => `${idx + 1}. ${(item.title || '未知文章')} -> ${(item.error || item.reason || '未知错误')}`)
        .join('\n')}${failedDetails.length > 5 ? '\n...更多请查看运行日志' : ''}`
      : '';

    window.alert(
      `导出完成\n总数：${result.stats.total}\n成功：${result.stats.scraped}\n付费跳过：${result.stats.skippedPaid}\n错误：${failedDetails.length || result.stats.skippedError || 0}${failedSummary}`
    );
  } catch (error) {
    setStatus(`导出失败：${error.message}`, 'error');
    window.alert(`导出失败：${error.message}`);
  } finally {
    state.isScraping = false;
    if (state.scrapeMode === 'manual') {
      state.scrapeMode = null;
    }
    updateActionState();
  }
}

async function stopExport() {
  if (!state.isScraping) {
    return;
  }

  if (state.scrapeMode === 'full' && electronAPI.stopFullExport) {
    await electronAPI.stopFullExport();
    setStatus('已发送停止请求，正在保存全量导出进度', 'warn');
    return;
  }

  await electronAPI.stopScraping();
  setStatus('已发送停止请求，等待当前任务收尾', 'warn');
}

function bindEvents() {
  qrLoginBtn.addEventListener('click', async () => {
    if (!electronAPI.startQrLogin) {
      setStatus('当前版本不支持扫码登录，请升级应用', 'error');
      return;
    }

    qrLoginBtn.disabled = true;
    const prevText = qrLoginBtn.textContent;
    qrLoginBtn.textContent = '等待扫码...';
    setStatus('已打开扫码窗口，请在弹窗中完成微信登录');

    try {
      const result = await electronAPI.startQrLogin();

      if (result && result.success && result.session) {
        tokenInput.value = result.session.token || '';
        cookieInput.value = result.session.cookie || '';
        userAgentInput.value = result.session.userAgent || '';
        setBadge(sessionBadge, '扫码登录成功', 'success');
        setStatus('扫码登录成功，会话已自动回填', 'success');
        return;
      }

      if (result && result.canceled) {
        setStatus('已取消扫码登录', 'warn');
        return;
      }

      setStatus(`扫码登录失败：${(result && result.error) || '未知错误'}`, 'error');
    } catch (error) {
      setStatus(`扫码登录失败：${error.message}`, 'error');
    } finally {
      qrLoginBtn.disabled = false;
      qrLoginBtn.textContent = prevText;
    }
  });

  saveSessionBtn.addEventListener('click', saveSession);
  clearSessionBtn.addEventListener('click', clearSession);
  testSessionBtn.addEventListener('click', testSession);

  openMpBtn.addEventListener('click', async () => {
    const result = await electronAPI.openMpPlatform();
    if (!result.success) {
      setStatus(`打开公众号平台失败：${result.error}`, 'error');
      return;
    }

    setStatus('已在系统浏览器打开微信公众号平台');
  });

  searchBtn.addEventListener('click', searchAccounts);
  accountKeyword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      searchAccounts();
    }
  });

  loadArticlesBtn.addEventListener('click', loadArticles);

  clearArticlesBtn.addEventListener('click', () => {
    state.articles = [];
    state.selectedArticleIds.clear();
    renderArticles();
    setStatus('文章列表已清空');
  });

  selectAllBtn.addEventListener('click', () => {
    state.selectedArticleIds = new Set(state.articles.map((article) => article.id));
    renderArticles();
  });

  clearSelectionBtn.addEventListener('click', () => {
    state.selectedArticleIds.clear();
    renderArticles();
  });

  selectDirBtn.addEventListener('click', async () => {
    const result = await electronAPI.selectOutputDir();
    if (!result.success) {
      return;
    }

    outputDir.value = result.path;
    localStorage.setItem('wechat_scraper_output_dir', result.path);
    updateActionState();
  });

  startFullExportBtn.addEventListener('click', startFullExport);
  resumeFullExportBtn.addEventListener('click', resumeFullExport);
  saveIncrementalConfigBtn.addEventListener('click', saveIncrementalConfigFromForm);
  addIncrementalTargetBtn.addEventListener('click', addSelectedAccountToIncrementalTargets);
  runIncrementalNowBtn.addEventListener('click', runIncrementalSyncNow);
  stopIncrementalBtn.addEventListener('click', async () => {
    const result = await electronAPI.stopIncrementalSync();
    if (!result.success) {
      setStatus(`停止增量同步失败：${result.error}`, 'error');
      return;
    }
    setStatus(result.message || '已请求停止增量同步', 'warn');
  });
  startBtn.addEventListener('click', startExport);
  stopBtn.addEventListener('click', stopExport);
}

async function hydrateSessionFromDisk() {
  const result = await electronAPI.loadSession();
  if (!result.success || !result.session) {
    return;
  }

  tokenInput.value = result.session.token || '';
  cookieInput.value = result.session.cookie || '';
  userAgentInput.value = result.session.userAgent || '';

  if (result.session.token && result.session.cookie) {
    setBadge(sessionBadge, '会话已加载', 'success');
  } else {
    setBadge(sessionBadge, '未配置会话', 'muted');
  }
}

function hydrateOutputDir() {
  const saved = localStorage.getItem('wechat_scraper_output_dir');
  if (saved) {
    outputDir.value = saved;
  }
}

function bindIpcEvents() {
  electronAPI.onStatusUpdate((status) => {
    if (!status || !status.message) {
      return;
    }
    setStatus(status.message, status.level || 'info');
  });

  electronAPI.onScrapingProgress((progress) => {
    updateProgress(progress || {});
  });

  if (electronAPI.onFullExportProgress) {
    electronAPI.onFullExportProgress((payload) => {
      if (!payload) {
        return;
      }

      if (!state.isScraping || state.scrapeMode !== 'full') {
        state.isScraping = true;
        state.scrapeMode = 'full';
      }

      if (payload.taskId) {
        state.activeFullTaskId = payload.taskId;
      }

      const stats = payload.stats || {};
      const total = Number(
        payload.totalCount
        || stats.totalExpected
        || state.fullExportTask?.stats?.totalExpected
        || 0
      );
      const processed = Number(stats.processedArticles || 0);
      const percentage = Number(
        payload.percentage
        || (total > 0 ? Math.round((processed / total) * 100) : 0)
      );
      const articleLabel = payload.currentArticle?.title || payload.message || '';

      updateProgress({
        current: processed,
        total,
        percentage,
        article: articleLabel
      });

      updateStatsByFullExport({
        totalExpected: total,
        exported: Number(stats.exported || 0),
        skippedPaid: Number(stats.skippedPaid || 0),
        failed: Number(stats.failed || 0)
      });

      const mergedTask = {
        ...(state.fullExportTask || {}),
        taskId: payload.taskId || state.activeFullTaskId || state.fullExportTask?.taskId || '',
        status: 'running',
        updatedAt: new Date().toISOString(),
        cursor: {
          ...(state.fullExportTask?.cursor || {}),
          ...(payload.cursor || {})
        },
        stats: {
          ...(state.fullExportTask?.stats || {}),
          indexedPages: Number(stats.indexedPages || 0),
          totalExpected: total,
          processedArticles: processed,
          exported: Number(stats.exported || 0),
          skippedExisting: Number(stats.skippedExisting || 0),
          skippedPaid: Number(stats.skippedPaid || 0),
          failed: Number(stats.failed || 0)
        }
      };
      renderFullExportTask(mergedTask);
      setStatusTextOnly(`[全量导出] ${payload.message || '任务执行中'}`);

      const now = Date.now();
      if (payload.message && now - state.lastFullProgressLogAt >= 5000) {
        appendLog(`[全量导出] ${payload.message}`, 'info');
        state.lastFullProgressLogAt = now;
      }

      updateActionState();
    });
  }

  if (electronAPI.onFullExportDone) {
    electronAPI.onFullExportDone((payload) => {
      if (!payload) {
        return;
      }

      const summary = payload.summary || {};
      const totalExpected = Number(summary.totalExpected || 0);
      const processed = Number(summary.processedArticles || 0);
      const exported = Number(summary.exported || 0);
      const skippedExisting = Number(summary.skippedExisting || 0);
      const skippedPaid = Number(summary.skippedPaid || 0);
      const failed = Number(summary.failed || 0);

      updateStatsByFullExport({
        totalExpected,
        exported,
        skippedPaid,
        failed
      });

      const percentage = payload.status === 'completed'
        ? 100
        : (totalExpected > 0 ? Math.min(99, Math.round((processed / totalExpected) * 100)) : 0);
      updateProgress({
        current: processed,
        total: totalExpected,
        percentage,
        article: ''
      });

      if (payload.task) {
        renderFullExportTask(payload.task);
      } else if (state.fullExportTask) {
        renderFullExportTask({
          ...state.fullExportTask,
          status: payload.status || state.fullExportTask.status,
          updatedAt: new Date().toISOString()
        });
      }

      if (state.scrapeMode === 'full') {
        state.isScraping = false;
        state.scrapeMode = null;
      }
      updateActionState();

      if (payload.reportPath) {
        appendLog(`失败明细报告已生成：${payload.reportPath}`, 'warn');
      }

      if (payload.status === 'completed') {
        setStatus(`全量导出完成：成功 ${exported} 篇`, 'success');
        window.alert(
          `全量导出完成\n预计总数：${totalExpected || '未知'}\n已处理：${processed}\n成功：${exported}\n已存在跳过：${skippedExisting}\n付费跳过：${skippedPaid}\n失败：${failed}${payload.reportPath ? `\n失败报告：${payload.reportPath}` : ''}`
        );
        return;
      }

      if (payload.status === 'paused') {
        setStatus('全量导出已暂停，可稍后继续', 'warn');
        return;
      }

      if (payload.status === 'failed') {
        const reason = payload.error || '未知错误';
        setStatus(`全量导出失败：${reason}`, 'error');
        window.alert(`全量导出失败：${reason}`);
      }
    });
  }

  if (electronAPI.onIncrementalSyncProgress) {
    electronAPI.onIncrementalSyncProgress((payload) => {
      if (!payload) {
        return;
      }

      if (!state.isIncrementalRunning) {
        state.isIncrementalRunning = true;
      }
      if (!state.isScraping || state.scrapeMode !== 'incremental') {
        state.isScraping = true;
        state.scrapeMode = 'incremental';
      }

      const now = Date.now();
      const type = String(payload.type || '');
      if (type === 'target-start') {
        appendLog(`[增量] ${payload.index}/${payload.totalTargets} 开始：${payload.target?.accountName || '-'}`, 'info');
      } else if (type === 'target-indexed') {
        appendLog(`[增量] ${payload.target?.accountName || '-'}：窗口内 ${payload.totalArticles || 0} 篇`, 'info');
      } else if (type === 'target-progress') {
        const total = Number(payload.total || 0);
        const current = Number(payload.current || 0);
        if (total > 0 && (current === total || now - state.lastIncrementalProgressLogAt >= 5000)) {
          appendLog(`[增量] ${payload.target?.accountName || '-'}：${current}/${total}`, 'info');
          state.lastIncrementalProgressLogAt = now;
        }
      }

      setBadge(incrementalModeBadge, '执行中', 'success');
      updateActionState();
    });
  }

  if (electronAPI.onIncrementalSyncDone) {
    electronAPI.onIncrementalSyncDone((payload) => {
      state.isIncrementalRunning = false;
      if (state.scrapeMode === 'incremental') {
        state.scrapeMode = null;
      }
      state.isScraping = false;

      if (payload?.config) {
        state.incrementalConfig = payload.config;
      }
      renderIncrementalConfig();
      updateActionState();

      const status = String(payload?.status || '').toLowerCase();
      const message = payload?.message || '增量同步已结束';
      if (status === 'success') {
        setStatus(message, 'success');
      } else if (status === 'partial_failed' || status === 'skipped_conflict') {
        setStatus(message, 'warn');
      } else {
        setStatus(message, 'error');
      }
    });
  }
}

async function init() {
  bindEvents();
  bindIpcEvents();
  hydrateOutputDir();

  await hydrateSessionFromDisk();

  if (!supportsFullExport) {
    startFullExportBtn.disabled = true;
    resumeFullExportBtn.disabled = true;
    fullExportSnapshot.textContent = '当前版本不支持全量导出，请升级主进程与 preload。';
  }
  if (!supportsIncrementalSync) {
    saveIncrementalConfigBtn.disabled = true;
    addIncrementalTargetBtn.disabled = true;
    runIncrementalNowBtn.disabled = true;
    stopIncrementalBtn.disabled = true;
    incrementalSnapshot.textContent = '当前版本不支持增量同步，请升级主进程与 preload。';
  } else {
    await refreshIncrementalConfig();
  }

  updateActionState();
  renderAccounts();
  renderArticles();
  renderFullExportTask(null);
  setStatus('应用已启动，请先配置公众号平台登录态');
}

init();
