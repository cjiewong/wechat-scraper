const { app, BrowserWindow, ipcMain, dialog, shell, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs-extra');

const config = require('./modules/config');
const ArticleScraper = require('./modules/scraper');
const ContentConverter = require('./modules/converter');
const FileManager = require('./modules/fileManager');
const Logger = require('./modules/logger');
const {
  loadConfig: loadIncrementalConfigFile,
  saveConfig: saveIncrementalConfigFile,
  runIncrementalBatch,
  createTargetFromAccount
} = require('./modules/incrementalSync');

try {
  // Enable optional manual GC in long-running exports when Electron allows it.
  app.commandLine.appendSwitch('js-flags', '--expose-gc');
} catch (error) {
  // ignore flag setup failures
}

let mainWindow = null;
let scraper = null;
let logger = null;
let converter = null;
let fileManager = null;
let isScraping = false;
let qrLoginWindow = null;
let activeScrapeMode = null; // manual | full | null
let activeFullExportTaskId = '';
let fullExportPromise = null;
let memoryMonitorTimer = null;
let autoResumeTimer = null;
let autoResumeTaskId = '';
let incrementalSyncPromise = null;
let incrementalStopRequested = false;
let incrementalSchedulerTimer = null;
let incrementalConfigCache = null;

function getAppStorageRoot() {
  if (app.isPackaged) {
    return app.getPath('userData');
  }
  return __dirname;
}

function getTasksDir() {
  return path.join(getAppStorageRoot(), 'data', 'tasks');
}

function getIncrementalConfigPath() {
  return path.join(getAppStorageRoot(), 'data', 'incremental-sync-config.json');
}

function getNowHmLocal() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getNowYmdLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function summarizeIncrementalConfigForClient(configPayload) {
  if (!configPayload) {
    return null;
  }

  return {
    version: Number(configPayload.version || 1),
    scheduler: {
      ...(configPayload.scheduler || {})
    },
    runtime: {
      ...(configPayload.runtime || {})
    },
    targets: Array.isArray(configPayload.targets)
      ? configPayload.targets.map((item) => ({
          ...item
        }))
      : []
  };
}
const MAX_TASK_FAILURE_CACHE = 500;
const MEMORY_MONITOR_INTERVAL_MS = 30000;
const MEMORY_WARN_RSS_MB = 1200;
const MEMORY_WARN_HEAP_MB = 700;
const MEMORY_SOFT_PAUSE_RSS_MB = 2600;
const MEMORY_SOFT_PAUSE_HEAP_MB = 1800;
const MEMORY_CHECK_ARTICLE_INTERVAL = 5;
const MEMORY_PROACTIVE_GC_INTERVAL = 40;
const AUTO_RESUME_BASE_DELAY_MS = 15000;
const AUTO_RESUME_MAX_DELAY_MS = 120000;
const AUTO_RESUME_MAX_ATTEMPTS = 50;
const INCREMENTAL_SCHEDULER_TICK_MS = 30000;

function sendStatus(message, level = 'info') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('status-update', {
    level,
    message,
    timestamp: new Date().toISOString()
  });
}

function toMB(bytes) {
  return Math.round((Number(bytes || 0) / (1024 * 1024)) * 10) / 10;
}

function stopMemoryMonitor() {
  if (memoryMonitorTimer) {
    clearInterval(memoryMonitorTimer);
    memoryMonitorTimer = null;
  }
}

function startMemoryMonitor(tag = '') {
  stopMemoryMonitor();

  memoryMonitorTimer = setInterval(async () => {
    try {
      if (!logger) {
        return;
      }

      const usage = process.memoryUsage();
      const snapshot = {
        tag,
        rssMB: toMB(usage.rss),
        heapUsedMB: toMB(usage.heapUsed),
        heapTotalMB: toMB(usage.heapTotal),
        externalMB: toMB(usage.external),
        arrayBuffersMB: toMB(usage.arrayBuffers || 0),
        activeMode: activeScrapeMode || 'none',
        activeTaskId: activeFullExportTaskId || ''
      };

      if (snapshot.rssMB >= MEMORY_WARN_RSS_MB || snapshot.heapUsedMB >= MEMORY_WARN_HEAP_MB) {
        await logger.warn('High memory usage detected', snapshot);
      }
    } catch (error) {
      // ignore memory monitor logging failures
    }
  }, MEMORY_MONITOR_INTERVAL_MS);

  if (memoryMonitorTimer && typeof memoryMonitorTimer.unref === 'function') {
    memoryMonitorTimer.unref();
  }
}

function getMemorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssMB: toMB(usage.rss),
    heapUsedMB: toMB(usage.heapUsed),
    heapTotalMB: toMB(usage.heapTotal),
    externalMB: toMB(usage.external),
    arrayBuffersMB: toMB(usage.arrayBuffers || 0)
  };
}

function clearAutoResumeTimer() {
  if (autoResumeTimer) {
    clearTimeout(autoResumeTimer);
    autoResumeTimer = null;
  }
  autoResumeTaskId = '';
}

function computeAutoResumeDelayMs(attempt) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const raw = AUTO_RESUME_BASE_DELAY_MS * (2 ** (safeAttempt - 1));
  return Math.min(AUTO_RESUME_MAX_DELAY_MS, raw);
}

async function scheduleAutoResumeAfterMemoryPause(taskId, reason = '') {
  if (!taskId) {
    return;
  }

  const current = await loadFullExportTaskByTaskId(taskId);
  if (!current || String(current.status || '').toLowerCase() !== 'paused') {
    return;
  }

  const existingAttempt = Number(current.memoryAutoResume?.attempt || 0);
  const attempt = existingAttempt + 1;
  const delayMs = computeAutoResumeDelayMs(attempt);
  const now = new Date();
  const nextResumeAt = new Date(now.getTime() + delayMs).toISOString();

  current.memoryAutoResume = {
    attempt,
    maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
    lastScheduledAt: now.toISOString(),
    nextResumeAt,
    delayMs
  };

  if (attempt > AUTO_RESUME_MAX_ATTEMPTS) {
    current.lastError = `${reason || current.lastError || '内存占用过高'}；自动续跑已达到上限(${AUTO_RESUME_MAX_ATTEMPTS})，请稍后手动继续`;
    await saveFullExportTask(current);
    sendStatus(`自动续跑已达上限(${AUTO_RESUME_MAX_ATTEMPTS})，请手动继续任务`, 'warn');
    if (logger) {
      await logger.warn('Skip auto resume because max attempts reached', {
        taskId,
        attempt,
        maxAttempts: AUTO_RESUME_MAX_ATTEMPTS
      });
    }
    return;
  }

  await saveFullExportTask(current);
  clearAutoResumeTimer();
  autoResumeTaskId = taskId;

  const seconds = Math.max(1, Math.round(delayMs / 1000));
  sendStatus(`内存保护：任务将在 ${seconds} 秒后自动继续（第 ${attempt} 次）`, 'warn');

  if (logger) {
    await logger.warn('Scheduled auto resume after memory pause', {
      taskId,
      attempt,
      delayMs,
      nextResumeAt
    });
  }

  autoResumeTimer = setTimeout(async () => {
    const targetTaskId = autoResumeTaskId;
    clearAutoResumeTimer();

    if (!targetTaskId) {
      return;
    }

    if (fullExportPromise || isScraping || activeScrapeMode === 'manual') {
      return;
    }

    try {
      const latest = await loadFullExportTaskByTaskId(targetTaskId);
      if (!latest || String(latest.status || '').toLowerCase() !== 'paused') {
        return;
      }

      latest.status = 'pending';
      latest.updatedAt = new Date().toISOString();
      latest.lastError = reason || latest.lastError || '';
      await saveFullExportTask(latest);

      sendStatus(`正在自动继续任务：${latest.accountName || latest.fakeid}`, 'info');
      await launchFullExport(latest, { source: 'auto-resume' });
    } catch (error) {
      if (logger) {
        await logger.error('Auto resume failed', {
          taskId: targetTaskId,
          error: error.message || String(error)
        });
      }
      sendStatus(`自动继续失败：${error.message || String(error)}`, 'error');
    }
  }, delayMs);

  if (autoResumeTimer && typeof autoResumeTimer.unref === 'function') {
    autoResumeTimer.unref();
  }
}

function extractTokenFromUrl(url) {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('token') || '';
  } catch (error) {
    return '';
  }
}

function toCookieString(cookies = []) {
  return cookies
    .filter((item) => item && item.name)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');
}

function getSessionFilePath() {
  if (app.isPackaged) {
    return path.join(getAppStorageRoot(), 'data', 'session.json');
  }

  const configured = config.storage.sessionPath;
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.join(__dirname, configured);
}

async function loadSessionFromDisk() {
  const filePath = getSessionFilePath();

  try {
    if (!(await fs.pathExists(filePath))) {
      return null;
    }

    const payload = await fs.readJson(filePath);
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    return {
      token: payload.token || '',
      cookie: payload.cookie || '',
      userAgent: payload.userAgent || config.scraper.defaultUserAgent
    };
  } catch (error) {
    if (logger) {
      await logger.warn('Failed to load session from disk', { error: error.message });
    }
    return null;
  }
}

async function saveSessionToDisk(session) {
  const filePath = getSessionFilePath();
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(
    filePath,
    {
      token: session.token || '',
      cookie: session.cookie || '',
      userAgent: session.userAgent || config.scraper.defaultUserAgent,
      updatedAt: new Date().toISOString()
    },
    { spaces: 2 }
  );
}

async function clearSessionFromDisk() {
  const filePath = getSessionFilePath();
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}
async function clearMpPlatformCookies() {
  const ses = electronSession.defaultSession;
  if (!ses) {
    return { removed: 0 };
  }
 
  const cookies = await ses.cookies.get({});
  let removed = 0;

  for (const item of cookies) {
    const domain = String(item.domain || '').replace(/^\./, '').toLowerCase();
    if (!domain.endsWith('weixin.qq.com')) {
      continue;
    }

    const protocol = item.secure ? 'https' : 'http';
    const pathName = item.path && item.path.startsWith('/') ? item.path : `/${item.path || ''}`;
    const cookieUrl = `${protocol}://${domain}${pathName}`;

    try {
      await ses.cookies.remove(cookieUrl, item.name);
      removed += 1;
    } catch (error) {
      // 忽略单个 cookie 删除失败，继续尝试清理其他项
    }
  }

  try {
    await ses.clearStorageData({
      origins: ['https://mp.weixin.qq.com'],
      storages: ['cookies', 'localstorage', 'indexeddb', 'serviceworkers', 'cachestorage']
    });
  } catch (error) {
    // 部分 Electron 版本可能不支持 origins，忽略即可
  }

  return { removed };
}

function sanitizeTaskKey(raw) {
  return String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128) || 'unknown';
}

async function ensureTaskDir() {
  await fs.ensureDir(getTasksDir());
}

function getTaskFilePathByFakeid(fakeid) {
  const key = sanitizeTaskKey(fakeid);
  return path.join(getTasksDir(), `full-export-${key}.json`);
}

async function saveFullExportTask(task) {
  await ensureTaskDir();
  const filePath = task.filePath || getTaskFilePathByFakeid(task.fakeid);
  const payload = {
    ...task,
    filePath
  };
  await fs.writeJson(filePath, payload, { spaces: 2 });
  return payload;
}

async function normalizeRecoveredTaskState(task) {
  if (!task) {
    return null;
  }

  const status = String(task.status || '').toLowerCase();
  const isCurrentActiveTask = Boolean(fullExportPromise && task.taskId && task.taskId === activeFullExportTaskId);
  if (status !== 'running' || isCurrentActiveTask) {
    return task;
  }

  const normalized = {
    ...task,
    status: 'paused',
    updatedAt: new Date().toISOString(),
    lastError: task.lastError || '检测到上次任务异常中断，已自动标记为暂停'
  };

  return saveFullExportTask(normalized);
}

async function loadFullExportTaskByFakeid(fakeid) {
  const filePath = getTaskFilePathByFakeid(fakeid);
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const task = await fs.readJson(filePath);
  return normalizeRecoveredTaskState({ ...task, filePath });
}

async function loadFullExportTaskByTaskId(taskId) {
  if (!taskId) {
    return null;
  }

  await ensureTaskDir();
  const tasksDir = getTasksDir();
  const files = await fs.readdir(tasksDir);
  for (const name of files) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const fullPath = path.join(tasksDir, name);
    try {
      const payload = await fs.readJson(fullPath);
      if (payload && payload.taskId === taskId) {
        return normalizeRecoveredTaskState({ ...payload, filePath: fullPath });
      }
    } catch (error) {
      // ignore malformed task file
    }
  }

  return null;
}

function getManifestPath(outputDir) {
  return path.join(outputDir, '.wechat-export-manifest.json');
}

async function loadExportManifest(outputDir) {
  const manifestPath = getManifestPath(outputDir);
  if (!(await fs.pathExists(manifestPath))) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: {}
    };
  }

  try {
    const raw = await fs.readJson(manifestPath);
    return {
      version: 1,
      updatedAt: raw.updatedAt || new Date().toISOString(),
      items: raw.items && typeof raw.items === 'object' ? raw.items : {}
    };
  } catch (error) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: {}
    };
  }
}

async function saveExportManifest(outputDir, manifest) {
  const manifestPath = getManifestPath(outputDir);
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(
    manifestPath,
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: manifest.items || {}
    },
    { spaces: 2 }
  );
}

async function loadIncrementalSyncConfig() {
  const loaded = await loadIncrementalConfigFile(getIncrementalConfigPath());
  incrementalConfigCache = loaded;
  return loaded;
}

async function saveIncrementalSyncConfig(nextConfig) {
  const saved = await saveIncrementalConfigFile(getIncrementalConfigPath(), nextConfig);
  incrementalConfigCache = saved;
  return saved;
}

function summarizeTaskForClient(task) {
  if (!task) {
    return null;
  }

  const { seenArticleIds, failures, ...rest } = task;
  return {
    ...rest,
    failureCount: Array.isArray(failures) ? failures.length : 0,
    seenArticleCount: Array.isArray(seenArticleIds) ? seenArticleIds.length : 0
  };
}

function emitFullExportProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('full-export-progress', payload);
  }
}

function emitFullExportDone(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('full-export-done', payload);
  }
}

function emitIncrementalSyncProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('incremental-sync-progress', payload);
  }
}

function emitIncrementalSyncDone(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('incremental-sync-done', payload);
  }
}

async function markActiveFullExportTaskAsInterrupted(reason) {
  clearAutoResumeTimer();

  if (!activeFullExportTaskId) {
    return null;
  }

  const task = await loadFullExportTaskByTaskId(activeFullExportTaskId);
  if (!task) {
    return null;
  }

  if (['completed', 'failed', 'paused'].includes(String(task.status || '').toLowerCase())) {
    return task;
  }

  task.status = 'failed';
  task.lastError = reason || '任务异常中断';
  task.updatedAt = new Date().toISOString();
  task.finishedAt = '';
  await saveFullExportTask(task);

  emitFullExportDone({
    taskId: task.taskId,
    status: 'failed',
    error: task.lastError,
    summary: {
      totalExpected: task.stats?.totalExpected || 0,
      processedArticles: task.stats?.processedArticles || 0,
      exported: task.stats?.exported || 0,
      skippedExisting: task.stats?.skippedExisting || 0,
      skippedPaid: task.stats?.skippedPaid || 0,
      failed: task.stats?.failed || 0
    },
    task: summarizeTaskForClient(task)
  });

  return task;
}

async function writeFailureReport(task, failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return '';
  }

  const fileName = `failed-articles-${sanitizeTaskKey(task.fakeid)}.json`;
  const reportPath = path.join(task.outputDir, fileName);
  await fs.writeJson(
    reportPath,
    {
      taskId: task.taskId,
      fakeid: task.fakeid,
      accountName: task.accountName || '',
      exportedAt: new Date().toISOString(),
      totalFailures: failures.length,
      failures
    },
    { spaces: 2 }
  );
  return reportPath;
}

function makeProgressPayload(task, phase, message, currentArticle = null) {
  const total = Number(task.stats.totalExpected || 0);
  const current = Number(task.stats.processedArticles || 0);
  const percentage = total > 0 ? Math.min(99, Math.round((current / total) * 100)) : 0;

  return {
    taskId: task.taskId,
    phase,
    message,
    percentage,
    currentArticle,
    cursor: {
      begin: task.cursor.begin,
      pageIndex: task.cursor.pageIndex,
      pageSize: task.cursor.pageSize
    },
    totalCount: total,
    stats: {
      indexedPages: task.stats.indexedPages || 0,
      processedArticles: task.stats.processedArticles || 0,
      exported: task.stats.exported || 0,
      skippedExisting: task.stats.skippedExisting || 0,
      skippedPaid: task.stats.skippedPaid || 0,
      failed: task.stats.failed || 0
    }
  };
}

async function runFullExportTask(task) {
  const manager = new FileManager(task.outputDir);
  const failures = Array.isArray(task.failures) ? task.failures.slice() : [];
  const seenSet = new Set(Array.isArray(task.seenArticleIds) ? task.seenArticleIds : []);
  const manifest = await loadExportManifest(task.outputDir);
  let autoPausedByMemory = false;
  let autoPausedReason = '';

  task.status = 'running';
  task.updatedAt = new Date().toISOString();
  task.lastError = '';
  if (!task.memoryAutoResume || typeof task.memoryAutoResume !== 'object') {
    task.memoryAutoResume = {
      attempt: 0,
      maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
      lastScheduledAt: '',
      nextResumeAt: '',
      delayMs: 0
    };
  }
  await saveFullExportTask(task);

  sendStatus(`开始全量导出：${task.accountName || task.fakeid}`, 'info');
  emitFullExportProgress(makeProgressPayload(task, 'indexing', '任务已启动'));

  try {
    const maybeAutoPauseForMemory = async (stage) => {
      let snapshot = getMemorySnapshot();
      let overSoftLimit = snapshot.heapUsedMB >= MEMORY_SOFT_PAUSE_HEAP_MB
        || snapshot.rssMB >= MEMORY_SOFT_PAUSE_RSS_MB;

      if (overSoftLimit && typeof global.gc === 'function') {
        try {
          global.gc();
          snapshot = getMemorySnapshot();
          overSoftLimit = snapshot.heapUsedMB >= MEMORY_SOFT_PAUSE_HEAP_MB
            || snapshot.rssMB >= MEMORY_SOFT_PAUSE_RSS_MB;
        } catch (error) {
          // ignore gc trigger errors
        }
      }

      if (!overSoftLimit) {
        return false;
      }

      autoPausedByMemory = true;
      autoPausedReason = `内存占用过高，任务已自动暂停（heap=${snapshot.heapUsedMB}MB, rss=${snapshot.rssMB}MB）`;
      scraper.stop();
      sendStatus(autoPausedReason, 'warn');

      if (logger) {
        await logger.warn('Auto paused full export due to high memory watermark', {
          taskId: task.taskId,
          stage,
          ...snapshot,
          processedArticles: task.stats.processedArticles || 0,
          exported: task.stats.exported || 0,
          failed: task.stats.failed || 0
        });
      }

      return true;
    };

    while (!scraper.stopped) {
      if (await maybeAutoPauseForMemory('before_page_request')) {
        break;
      }

      const begin = Number(task.cursor.begin || 0);
      const pageSize = Number(task.cursor.pageSize || 10);
      const referer = `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?token=${encodeURIComponent(scraper.getSession().token)}&lang=zh_CN`;
      const data = await scraper.requestJSON(
        '/cgi-bin/appmsgpublish',
        {
          sub: 'list',
          sub_action: 'list_ex',
          begin,
          count: pageSize,
          fakeid: task.fakeid,
          token: scraper.getSession().token,
          lang: 'zh_CN',
          f: 'json',
          ajax: 1
        },
        referer,
        {
          maxRet200013Retries: 5,
          ret200013BackoffMs: 3000
        }
      );

      const publishPage = scraper.decodeMaybeJson(data.publish_page) || {};
      const publishList = Array.isArray(publishPage.publish_list) ? publishPage.publish_list : [];
      const totalCount = Number(publishPage.total_count || 0);
      if (Number.isFinite(totalCount) && totalCount > 0) {
        task.stats.totalExpected = totalCount;
      }

      if (publishList.length === 0) {
        break;
      }

      task.stats.indexedPages += 1;
      emitFullExportProgress(
        makeProgressPayload(
          task,
          'indexing',
          `正在抓取目录页 ${task.cursor.pageIndex + 1}（本页 ${publishList.length} 条）`
        )
      );

      for (const publishItem of publishList) {
        if (scraper.stopped) {
          break;
        }

        const publishInfo = scraper.decodeMaybeJson(publishItem.publish_info);
        if (!publishInfo) {
          continue;
        }

        const articles = publishInfo.appmsgex || publishInfo.appmsg || [];
        for (const rawArticle of articles) {
          if (scraper.stopped) {
            break;
          }

          if (await maybeAutoPauseForMemory('before_article_scrape')) {
            break;
          }

          const article = scraper.normalizeArticleRecord(rawArticle);
          if (!article.url) {
            continue;
          }

          const articleKey = article.id || article.url;
          if (seenSet.has(articleKey)) {
            continue;
          }

          seenSet.add(articleKey);
          task.stats.processedArticles += 1;

          const manifestItem = manifest.items[articleKey];
          const expectedFilePath = manager.generateFilePath(article, task.format);
          const shouldSkipByManifest = Boolean(manifestItem);
          const shouldSkipByFile = await manager.fileExists(expectedFilePath);
          if (shouldSkipByManifest || shouldSkipByFile) {
            task.stats.skippedExisting += 1;
            if (!manifestItem) {
              manifest.items[articleKey] = {
                title: article.title || '',
                url: article.url || '',
                filePath: expectedFilePath,
                exportedAt: new Date().toISOString()
              };
            }

            emitFullExportProgress(
              makeProgressPayload(task, 'exporting', `跳过已存在：${article.title}`, {
                id: articleKey,
                title: article.title || ''
              })
            );
            continue;
          }

          const scraped = await scraper.scrapeArticle(article);
          if (scraped.skipped) {
            if (scraped.reason === 'paid') {
              task.stats.skippedPaid += 1;
            } else {
              task.stats.failed += 1;
            }

            if (scraped.reason === 'error') {
              failures.push({
                stage: 'scrape',
                id: articleKey,
                title: scraped.title || article.title || '',
                url: scraped.url || article.url || '',
                error: scraped.error || scraped.reason || '抓取失败'
              });
              if (failures.length > MAX_TASK_FAILURE_CACHE) {
                failures.splice(0, failures.length - MAX_TASK_FAILURE_CACHE);
              }
            }

            emitFullExportProgress(
              makeProgressPayload(task, 'exporting', `抓取跳过：${article.title}`, {
                id: articleKey,
                title: article.title || ''
              })
            );
            continue;
          }

          try {
            const filePath = await manager.generateUniqueFilePath(scraped, task.format);
            if (task.format === 'pdf') {
              const pdfResult = await converter.toPDF(scraped, [], filePath);
              if (!pdfResult.success) {
                throw new Error(pdfResult.error || 'PDF 生成失败');
              }
            } else {
              const markdown = await converter.toMarkdown(scraped, []);
              const saveResult = await manager.saveFile(filePath, markdown);
              if (!saveResult.success) {
                throw new Error(saveResult.error || 'Markdown 保存失败');
              }
            }

            task.stats.exported += 1;
            manifest.items[articleKey] = {
              title: scraped.title || article.title || '',
              url: scraped.url || article.url || '',
              filePath,
              exportedAt: new Date().toISOString()
            };

            emitFullExportProgress(
              makeProgressPayload(task, 'exporting', `已导出：${scraped.title || article.title}`, {
                id: articleKey,
                title: scraped.title || article.title || ''
              })
            );
          } catch (error) {
            task.stats.failed += 1;
            failures.push({
              stage: 'export',
              id: articleKey,
              title: scraped.title || article.title || '',
              url: scraped.url || article.url || '',
              error: error.message || '导出失败'
            });
            if (failures.length > MAX_TASK_FAILURE_CACHE) {
              failures.splice(0, failures.length - MAX_TASK_FAILURE_CACHE);
            }

            emitFullExportProgress(
              makeProgressPayload(task, 'exporting', `导出失败：${article.title}`, {
                id: articleKey,
                title: article.title || ''
              })
            );
          } finally {
            if (
              typeof global.gc === 'function'
              && task.stats.processedArticles > 0
              && task.stats.processedArticles % MEMORY_PROACTIVE_GC_INTERVAL === 0
            ) {
              try {
                global.gc();
              } catch (error) {
                // ignore proactive gc failures
              }
            }

            if (task.stats.processedArticles > 0 && task.stats.processedArticles % MEMORY_CHECK_ARTICLE_INTERVAL === 0) {
              if (await maybeAutoPauseForMemory('during_article_loop')) {
                break;
              }
            }
          }
        }
      }

      task.cursor.begin = begin + pageSize;
      task.cursor.pageIndex += 1;
      task.updatedAt = new Date().toISOString();
      task.seenArticleIds = Array.from(seenSet);
      task.failures = failures.slice(-MAX_TASK_FAILURE_CACHE);

      await saveExportManifest(task.outputDir, manifest);
      await saveFullExportTask(task);

      if (publishList.length < pageSize) {
        break;
      }
    }

    task.updatedAt = new Date().toISOString();
    task.seenArticleIds = Array.from(seenSet);
    task.failures = failures.slice(-MAX_TASK_FAILURE_CACHE);
    task.status = scraper.stopped ? 'paused' : 'completed';
    task.lastError = autoPausedByMemory ? autoPausedReason : '';
    task.finishedAt = task.status === 'completed' ? new Date().toISOString() : '';
    if (autoPausedByMemory) {
      task.memoryAutoResume = {
        ...(task.memoryAutoResume || {}),
        maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
        lastPausedAt: new Date().toISOString()
      };
    } else {
      task.memoryAutoResume = {
        attempt: 0,
        maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
        lastScheduledAt: '',
        nextResumeAt: '',
        delayMs: 0,
        lastPausedAt: ''
      };
    }

    await saveExportManifest(task.outputDir, manifest);
    await saveFullExportTask(task);

    const failureReportPath = await writeFailureReport(task, failures);
    emitFullExportDone({
      taskId: task.taskId,
      status: task.status,
      summary: {
        totalExpected: task.stats.totalExpected || 0,
        processedArticles: task.stats.processedArticles || 0,
        exported: task.stats.exported || 0,
        skippedExisting: task.stats.skippedExisting || 0,
        skippedPaid: task.stats.skippedPaid || 0,
        failed: task.stats.failed || 0
      },
      reportPath: failureReportPath,
      task: summarizeTaskForClient(task)
    });

    if (task.status === 'completed') {
      sendStatus(`全量导出完成：成功 ${task.stats.exported} 篇`, 'success');
    } else {
      sendStatus('全量导出已暂停，可稍后继续', 'warn');
    }
    return {
      taskId: task.taskId,
      status: task.status,
      autoPausedByMemory,
      autoPausedReason
    };
  } catch (error) {
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.lastError = error.message || String(error);
    task.seenArticleIds = Array.from(seenSet);
    task.failures = failures.slice(-MAX_TASK_FAILURE_CACHE);
    task.memoryAutoResume = {
      attempt: 0,
      maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
      lastScheduledAt: '',
      nextResumeAt: '',
      delayMs: 0,
      lastPausedAt: ''
    };
    await saveFullExportTask(task);

    emitFullExportDone({
      taskId: task.taskId,
      status: 'failed',
      error: task.lastError,
      summary: {
        totalExpected: task.stats.totalExpected || 0,
        processedArticles: task.stats.processedArticles || 0,
        exported: task.stats.exported || 0,
        skippedExisting: task.stats.skippedExisting || 0,
        skippedPaid: task.stats.skippedPaid || 0,
        failed: task.stats.failed || 0
      },
      task: summarizeTaskForClient(task)
    });

    sendStatus(`全量导出失败：${task.lastError}`, 'error');
    return {
      taskId: task.taskId,
      status: 'failed',
      autoPausedByMemory: false,
      autoPausedReason: ''
    };
  }
}

async function launchFullExport(task, options = {}) {
  if (fullExportPromise) {
    throw new Error('已有全量导出任务正在运行');
  }

  if (options.source !== 'auto-resume') {
    clearAutoResumeTimer();
  }

  scraper.resetStopFlag();
  isScraping = true;
  activeScrapeMode = 'full';
  activeFullExportTaskId = task.taskId;
  startMemoryMonitor(`full-export:${task.taskId}`);

  fullExportPromise = runFullExportTask(task)
    .then(async (result) => {
      if (result && result.status === 'paused' && result.autoPausedByMemory) {
        await scheduleAutoResumeAfterMemoryPause(result.taskId, result.autoPausedReason);
      }
      return result;
    })
    .finally(() => {
      isScraping = false;
      activeScrapeMode = null;
      activeFullExportTaskId = '';
      fullExportPromise = null;
      stopMemoryMonitor();
    });
}

function getEnabledIncrementalTargets(configPayload, targetIds = []) {
  const normalizedIds = Array.isArray(targetIds) ? targetIds.filter(Boolean) : [];
  const idSet = new Set(normalizedIds);
  const allEnabled = (configPayload.targets || []).filter((item) => item.enabled);
  if (!idSet.size) {
    return allEnabled;
  }
  return allEnabled.filter((item) => idSet.has(item.id));
}

function summarizeIncrementalRunStatus(result) {
  if (!result) {
    return {
      status: 'failed',
      message: '增量同步返回空结果'
    };
  }

  if (result.stopped) {
    return {
      status: 'failed',
      message: '增量同步已停止'
    };
  }

  const failed = Number(result.total?.failed || 0);
  if (failed > 0) {
    return {
      status: 'partial_failed',
      message: `增量同步完成，失败 ${failed} 篇`
    };
  }

  return {
    status: 'success',
    message: `增量同步完成，成功 ${Number(result.total?.exported || 0)} 篇`
  };
}

async function applyIncrementalResultToConfig(baseConfig, result, finalStatus) {
  const now = new Date().toISOString();
  const summaryMap = new Map();
  for (const item of result.summaries || []) {
    if (item && item.targetId) {
      summaryMap.set(item.targetId, item);
    }
  }

  const nextTargets = (baseConfig.targets || []).map((target) => {
    const matched = summaryMap.get(target.id);
    if (!matched) {
      return target;
    }

    const targetSummary = matched.summary || {};
    const failed = Number(targetSummary.failed || 0);
    const targetStatus = matched.fatalError
      ? 'failed'
      : (failed > 0 ? 'partial_failed' : (targetSummary.stopped ? 'failed' : 'success'));

    return {
      ...target,
      lastRunAt: now,
      lastStatus: targetStatus,
      lastSummary: {
        fetched: Number(targetSummary.fetched || 0),
        exported: Number(targetSummary.exported || 0),
        skippedExisting: Number(targetSummary.skippedExisting || 0),
        skippedPaid: Number(targetSummary.skippedPaid || 0),
        failed: Number(targetSummary.failed || 0)
      },
      lastError: String(matched.fatalError || '')
    };
  });

  const nextConfig = {
    ...baseConfig,
    targets: nextTargets,
    scheduler: {
      ...(baseConfig.scheduler || {}),
      lastRunAt: now,
      lastStatus: finalStatus.status,
      lastMessage: finalStatus.message
    }
  };

  return saveIncrementalSyncConfig(nextConfig);
}

async function launchIncrementalSync(options = {}) {
  if (incrementalSyncPromise) {
    throw new Error('已有增量同步任务正在运行');
  }
  if (isScraping) {
    throw new Error('已有任务执行中，请先停止当前任务');
  }

  const source = String(options.source || 'manual');
  const targetIds = Array.isArray(options.targetIds) ? options.targetIds : [];
  const runtimeOverride = options.runtime && typeof options.runtime === 'object'
    ? options.runtime
    : null;

  const loadedConfig = incrementalConfigCache || (await loadIncrementalSyncConfig());
  const selectedTargets = getEnabledIncrementalTargets(loadedConfig, targetIds);
  if (!selectedTargets.length) {
    throw new Error('没有已启用的增量同步目标');
  }

  const effectiveConfig = {
    ...loadedConfig,
    runtime: runtimeOverride
      ? {
          ...loadedConfig.runtime,
          ...runtimeOverride
        }
      : {
          ...loadedConfig.runtime
        },
    targets: selectedTargets.map((item) => ({ ...item }))
  };

  incrementalStopRequested = false;
  scraper.resetStopFlag();
  isScraping = true;
  activeScrapeMode = 'incremental';
  startMemoryMonitor(`incremental-sync:${source}`);
  sendStatus(`开始增量同步（${selectedTargets.length} 个公众号）`, 'info');

  const baseScraperConfig = {
    ...config,
    scraper: {
      ...config.scraper
    }
  };

  incrementalSyncPromise = runIncrementalBatch(effectiveConfig, {
    scraper,
    converter,
    logger,
    baseScraperConfig,
    shouldStop: () => incrementalStopRequested || Boolean(scraper.stopped),
    onProgress: (payload) => {
      emitIncrementalSyncProgress({
        source,
        ...(payload || {}),
        timestamp: new Date().toISOString()
      });

      if (!payload || !payload.type) {
        return;
      }

      if (payload.type === 'target-start') {
        sendStatus(
          `[增量] ${payload.index}/${payload.totalTargets} 开始：${payload.target?.accountName || '-'}`,
          'info'
        );
      } else if (payload.type === 'target-indexed') {
        sendStatus(
          `[增量] ${payload.target?.accountName || '-'}：窗口内 ${payload.totalArticles || 0} 篇`,
          'info'
        );
      } else if (payload.type === 'target-progress') {
        const total = Number(payload.total || 0);
        const current = Number(payload.current || 0);
        if (total > 0 && (current === total || current % 10 === 0)) {
          sendStatus(
            `[增量] ${payload.target?.accountName || '-'}：${current}/${total}`,
            'info'
          );
        }
      }
    }
  })
    .then(async (result) => {
      const finalStatus = summarizeIncrementalRunStatus(result);
      const savedConfig = await applyIncrementalResultToConfig(loadedConfig, result, finalStatus);
      emitIncrementalSyncDone({
        source,
        status: finalStatus.status,
        message: finalStatus.message,
        result,
        config: summarizeIncrementalConfigForClient(savedConfig)
      });

      if (finalStatus.status === 'success') {
        sendStatus(finalStatus.message, 'success');
      } else if (finalStatus.status === 'partial_failed') {
        sendStatus(finalStatus.message, 'warn');
      } else {
        sendStatus(finalStatus.message, 'warn');
      }
      return {
        status: finalStatus.status,
        message: finalStatus.message,
        result,
        config: savedConfig
      };
    })
    .catch(async (error) => {
      const loaded = incrementalConfigCache || loadedConfig;
      const failedConfig = await saveIncrementalSyncConfig({
        ...loaded,
        scheduler: {
          ...(loaded.scheduler || {}),
          lastRunAt: new Date().toISOString(),
          lastStatus: 'failed',
          lastMessage: error.message || String(error)
        }
      });
      emitIncrementalSyncDone({
        source,
        status: 'failed',
        message: error.message || String(error),
        result: null,
        config: summarizeIncrementalConfigForClient(failedConfig)
      });
      sendStatus(`增量同步失败：${error.message || String(error)}`, 'error');
      throw error;
    })
    .finally(() => {
      scraper.resetStopFlag();
      incrementalStopRequested = false;
      isScraping = false;
      if (activeScrapeMode === 'incremental') {
        activeScrapeMode = null;
      }
      incrementalSyncPromise = null;
      stopMemoryMonitor();
    });

  return incrementalSyncPromise;
}

function stopIncrementalScheduler() {
  if (incrementalSchedulerTimer) {
    clearInterval(incrementalSchedulerTimer);
    incrementalSchedulerTimer = null;
  }
}

function startIncrementalScheduler() {
  stopIncrementalScheduler();

  incrementalSchedulerTimer = setInterval(async () => {
    try {
      const loaded = incrementalConfigCache || (await loadIncrementalSyncConfig());
      const scheduler = loaded.scheduler || {};
      if (!scheduler.enabled) {
        return;
      }

      const nowHm = getNowHmLocal();
      const today = getNowYmdLocal();
      if (String(scheduler.dailyTime || '') !== nowHm) {
        return;
      }
      if (String(scheduler.lastTriggeredDate || '') === today) {
        return;
      }

      const markedConfig = await saveIncrementalSyncConfig({
        ...loaded,
        scheduler: {
          ...scheduler,
          lastTriggeredDate: today
        }
      });

      if (isScraping) {
        await saveIncrementalSyncConfig({
          ...markedConfig,
          scheduler: {
            ...(markedConfig.scheduler || {}),
            lastRunAt: new Date().toISOString(),
            lastStatus: 'skipped_conflict',
            lastMessage: '定时触发时检测到已有任务运行，已跳过'
          }
        });
        sendStatus('定时增量同步已跳过：当前有任务在执行', 'warn');
        return;
      }

      await launchIncrementalSync({ source: 'scheduler' });
    } catch (error) {
      if (logger) {
        await logger.error('Incremental scheduler tick failed', {
          error: error.message || String(error)
        });
      }
      sendStatus(`定时增量任务执行失败：${error.message || String(error)}`, 'error');
    }
  }, INCREMENTAL_SCHEDULER_TICK_MS);

  if (incrementalSchedulerTimer && typeof incrementalSchedulerTimer.unref === 'function') {
    incrementalSchedulerTimer.unref();
  }
}

function createWindow() {
  const windowIconPath = path.join(__dirname, 'assets', 'icon-1024.png');
  mainWindow = new BrowserWindow({
    width: config.app.windowWidth,
    height: config.app.windowHeight,
    minWidth: config.app.minWidth,
    minHeight: config.app.minHeight,
    title: config.app.title,
    icon: windowIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('render-process-gone', async (_event, details) => {
    const reason = details && details.reason ? details.reason : 'unknown';
    const exitCode = details && Number.isFinite(Number(details.exitCode)) ? Number(details.exitCode) : null;

    if (logger) {
      await logger.error('Renderer process gone', { reason, exitCode });
    }

    if (isScraping) {
      // 任务执行中如果渲染进程异常，尝试自动恢复窗口，避免触发 window-all-closed 后退出进程
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
          } else if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
          }
        } catch (error) {
          // ignore auto-recovery failures
        }
      }, 500);
    }
  });

  mainWindow.on('unresponsive', async () => {
    if (logger) {
      await logger.warn('Main window became unresponsive', {
        activeMode: activeScrapeMode || 'none',
        activeTaskId: activeFullExportTaskId || ''
      });
    }
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

async function initializeServices() {
  logger = new Logger(path.join(getAppStorageRoot(), 'logs'));
  await logger.init();
  await ensureTaskDir();
  await loadIncrementalSyncConfig();
  startIncrementalScheduler();

  scraper = new ArticleScraper(config, logger);
  converter = new ContentConverter();

  const session = await loadSessionFromDisk();
  if (session) {
    scraper.setSession(session);
    await logger.info('Loaded persisted mp session', {
      token: Boolean(session.token),
      cookieLength: session.cookie.length
    });
  }
}

ipcMain.handle('open-mp-platform', async () => {
  try {
    await shell.openExternal('https://mp.weixin.qq.com/');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-qr-login', async () => {
  if (qrLoginWindow && !qrLoginWindow.isDestroyed()) {
    qrLoginWindow.focus();
    return { success: false, error: '扫码窗口已打开，请在弹窗继续操作' };
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = async (payload) => {
      if (settled) {
        return;
      }

      settled = true;
      if (qrLoginWindow && !qrLoginWindow.isDestroyed()) {
        qrLoginWindow.close();
      }
      qrLoginWindow = null;
      resolve(payload);
    };

    const tryCaptureSession = async (targetUrl = '') => {
      if (settled || !qrLoginWindow || qrLoginWindow.isDestroyed()) {
        return;
      }

      // 登录后通常跳转到 /cgi-bin/home 并带 token
      const tokenFromUrl = extractTokenFromUrl(targetUrl);
      const mayBeLoggedIn = Boolean(tokenFromUrl) || /\/cgi-bin\//.test(targetUrl || '');
      if (!mayBeLoggedIn) {
        return;
      }

      try {
        const cookies = await qrLoginWindow.webContents.session.cookies.get({
          url: 'https://mp.weixin.qq.com/'
        });

        const tokenCookie = cookies.find((item) => String(item.name).toLowerCase() === 'token');
        const token = tokenFromUrl || (tokenCookie ? String(tokenCookie.value) : '');
        const cookie = toCookieString(cookies);

        if (!token || !cookie) {
          return;
        }

        const normalized = scraper.setSession({
          token,
          cookie,
          userAgent: config.scraper.defaultUserAgent
        });

        await saveSessionToDisk(normalized);
        await logger.info('Captured mp session by qr login', {
          token: Boolean(normalized.token),
          cookieLength: normalized.cookie.length
        });

        sendStatus('扫码登录成功，已自动回填会话', 'success');
        await finish({ success: true, session: normalized });
      } catch (error) {
        await finish({ success: false, error: error.message });
      }
    };

    qrLoginWindow = new BrowserWindow({
      width: 460,
      height: 760,
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true,
      title: '扫码登录公众号平台',
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false
      }
    });

    qrLoginWindow.webContents.on('did-navigate', (_event, url) => {
      void tryCaptureSession(url);
    });

    qrLoginWindow.webContents.on('did-redirect-navigation', (_event, url) => {
      void tryCaptureSession(url);
    });

    qrLoginWindow.webContents.on('did-navigate-in-page', (_event, url) => {
      void tryCaptureSession(url);
    });

    qrLoginWindow.on('closed', () => {
      if (!settled) {
        settled = true;
        qrLoginWindow = null;
        sendStatus('已取消扫码登录', 'warn');
        resolve({ success: false, canceled: true, error: '已取消扫码登录' });
      } else {
        qrLoginWindow = null;
      }
    });

    sendStatus('扫码窗口已打开，请在弹窗中完成微信登录', 'info');

    qrLoginWindow
      .loadURL('https://mp.weixin.qq.com/')
      .catch(async (error) => {
        await finish({ success: false, error: error.message });
      });
  });
});

ipcMain.handle('load-session', async () => {
  try {
    const session = scraper.getSession();
    return { success: true, session };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-session', async (_event, session) => {
  try {
    const normalized = scraper.setSession(session || {});
    await saveSessionToDisk(normalized);
    await logger.info('Updated mp session', {
      token: Boolean(normalized.token),
      cookieLength: normalized.cookie.length
    });

    return { success: true, session: normalized };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-session', async () => {
  try {
    const cleared = scraper.setSession({
      token: '',
      cookie: '',
      userAgent: config.scraper.defaultUserAgent
    });
    await clearSessionFromDisk();
    const cookieClearResult = await clearMpPlatformCookies();

    await logger.info('Cleared mp session and browser cookies', {
      removedCookies: cookieClearResult.removed
    });
    sendStatus('登录会话与浏览器 Cookie 已清空', 'success');
    return { success: true, session: cleared };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-session', async (_event, session) => {
  try {
    if (session && (session.token || session.cookie)) {
      scraper.setSession(session);
    }

    const result = await scraper.validateSession();
    sendStatus('登录态有效，可以开始搜索公众号', 'success');
    return { success: true, data: result };
  } catch (error) {
    sendStatus(`登录态检测失败：${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('search-accounts', async (_event, options) => {
  try {
    const { keyword, limit = 10, offset = 0 } = options || {};
    const accounts = await scraper.searchAccounts(keyword, limit, offset);
    return { success: true, accounts };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-article-list', async (_event, options) => {
  try {
    const articles = await scraper.getArticleList(options || {});
    return { success: true, articles };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-incremental-sync-config', async () => {
  try {
    const loaded = incrementalConfigCache || (await loadIncrementalSyncConfig());
    return {
      success: true,
      config: summarizeIncrementalConfigForClient(loaded)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-incremental-sync-config', async (_event, nextConfig) => {
  try {
    const saved = await saveIncrementalSyncConfig(nextConfig || {});
    return {
      success: true,
      config: summarizeIncrementalConfigForClient(saved)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-incremental-target-from-selected', async (_event, payload) => {
  try {
    const loaded = incrementalConfigCache || (await loadIncrementalSyncConfig());
    const target = createTargetFromAccount(payload || {});
    if ((loaded.targets || []).some((item) => item.fakeid === target.fakeid)) {
      throw new Error('该公众号已存在于增量同步配置中');
    }

    const saved = await saveIncrementalSyncConfig({
      ...loaded,
      targets: [...(loaded.targets || []), target]
    });

    return {
      success: true,
      config: summarizeIncrementalConfigForClient(saved)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-incremental-target', async (_event, payload) => {
  try {
    const id = String(payload?.id || '').trim();
    if (!id) {
      throw new Error('缺少目标 ID');
    }

    const loaded = incrementalConfigCache || (await loadIncrementalSyncConfig());
    const nextTargets = (loaded.targets || []).filter((item) => item.id !== id);
    const saved = await saveIncrementalSyncConfig({
      ...loaded,
      targets: nextTargets
    });

    return {
      success: true,
      config: summarizeIncrementalConfigForClient(saved)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('run-incremental-sync-now', async (_event, payload) => {
  try {
    const result = await launchIncrementalSync({
      source: 'manual',
      targetIds: Array.isArray(payload?.targetIds) ? payload.targetIds : [],
      runtime: payload?.runtime && typeof payload.runtime === 'object'
        ? payload.runtime
        : null
    });

    return {
      success: true,
      status: result.status,
      message: result.message,
      result: result.result,
      config: summarizeIncrementalConfigForClient(result.config)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-incremental-sync', async () => {
  if (!incrementalSyncPromise || activeScrapeMode !== 'incremental') {
    return { success: true, message: '当前没有运行中的增量同步任务' };
  }

  incrementalStopRequested = true;
  if (scraper) {
    scraper.stop();
  }
  sendStatus('已请求停止增量同步，正在等待任务收尾', 'warn');
  return { success: true };
});

ipcMain.handle('start-full-export', async (_event, options) => {
  if (isScraping) {
    return { success: false, error: '已有任务执行中，请先停止当前任务' };
  }

  try {
    const {
      fakeid,
      accountName = '',
      outputDir,
      format = 'md',
      pageSize = 10,
      resume = false
    } = options || {};

    if (!fakeid) {
      throw new Error('缺少 fakeid，无法启动全量导出');
    }
    if (!outputDir) {
      throw new Error('请先选择输出目录');
    }
    if (!['md', 'pdf'].includes(format)) {
      throw new Error('不支持的导出格式');
    }

    await fs.ensureDir(outputDir);

    const existing = await loadFullExportTaskByFakeid(fakeid);
    let task = null;
    if (resume && existing && ['paused', 'failed', 'running'].includes(existing.status)) {
      task = {
        ...existing,
        outputDir,
        accountName: accountName || existing.accountName || '',
        format,
        memoryAutoResume: {
          attempt: 0,
          maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
          lastScheduledAt: '',
          nextResumeAt: '',
          delayMs: 0,
          lastPausedAt: ''
        },
        cursor: {
          begin: Number(existing.cursor?.begin || 0),
          pageIndex: Number(existing.cursor?.pageIndex || 0),
          pageSize: Number(pageSize || existing.cursor?.pageSize || 10)
        },
        updatedAt: new Date().toISOString()
      };
    } else {
      task = {
        taskId: `full-export-${sanitizeTaskKey(fakeid)}`,
        fakeid,
        accountName,
        outputDir,
        format,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: '',
        lastError: '',
        cursor: {
          begin: 0,
          pageIndex: 0,
          pageSize: Math.max(1, Number(pageSize) || 10)
        },
        stats: {
          indexedPages: 0,
          totalExpected: 0,
          processedArticles: 0,
          exported: 0,
          skippedExisting: 0,
          skippedPaid: 0,
          failed: 0
        },
        seenArticleIds: [],
        failures: [],
        memoryAutoResume: {
          attempt: 0,
          maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
          lastScheduledAt: '',
          nextResumeAt: '',
          delayMs: 0,
          lastPausedAt: ''
        }
      };
    }

    task = await saveFullExportTask(task);
    await launchFullExport(task);

    return {
      success: true,
      task: summarizeTaskForClient(task)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-full-export', async () => {
  clearAutoResumeTimer();

  if (!fullExportPromise || activeScrapeMode !== 'full') {
    return { success: true, message: '当前没有运行中的全量导出任务' };
  }

  scraper.stop();
  sendStatus('已请求停止全量导出，正在保存进度', 'warn');
  return { success: true };
});

ipcMain.handle('get-full-export-task', async (_event, options) => {
  try {
    const { fakeid = '', taskId = '' } = options || {};
    let task = null;
    if (taskId) {
      task = await loadFullExportTaskByTaskId(taskId);
    } else if (fakeid) {
      task = await loadFullExportTaskByFakeid(fakeid);
    }

    return {
      success: true,
      exists: Boolean(task),
      task: summarizeTaskForClient(task)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('resume-full-export', async (_event, options) => {
  if (isScraping) {
    return { success: false, error: '已有任务执行中，请先停止当前任务' };
  }

  try {
    const { taskId = '', fakeid = '' } = options || {};
    let task = null;
    if (taskId) {
      task = await loadFullExportTaskByTaskId(taskId);
    } else if (fakeid) {
      task = await loadFullExportTaskByFakeid(fakeid);
    }

    if (!task) {
      throw new Error('未找到可续跑的任务');
    }
    if (task.status === 'completed') {
      throw new Error('任务已完成，无需续跑');
    }

    task.status = 'pending';
    task.updatedAt = new Date().toISOString();
    task.memoryAutoResume = {
      attempt: 0,
      maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
      lastScheduledAt: '',
      nextResumeAt: '',
      delayMs: 0,
      lastPausedAt: ''
    };
    task = await saveFullExportTask(task);
    await launchFullExport(task);

    return {
      success: true,
      task: summarizeTaskForClient(task)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-scraping', async (_event, options) => {
  if (isScraping) {
    const reason = activeScrapeMode === 'full'
      ? '全量导出任务正在执行，请先停止后再试'
      : '已有抓取任务正在执行';
    return { success: false, error: reason };
  }

  try {
    const {
      articles = [],
      outputDir,
      format = 'md'
    } = options || {};

    if (!outputDir) {
      throw new Error('请先选择输出目录');
    }

    if (!Array.isArray(articles) || articles.length === 0) {
      throw new Error('没有可导出的文章');
    }

    isScraping = true;
    activeScrapeMode = 'manual';
    scraper.resetStopFlag();
    fileManager = new FileManager(outputDir);
    startMemoryMonitor('manual-export');

    logger.stats = {
      total: articles.length,
      scraped: 0,
      skippedPaid: 0,
      skippedError: 0,
      imagesUploaded: 0,
      errors: []
    };

    sendStatus(`开始导出 ${articles.length} 篇文章`, 'info');

    const scrapedResults = await scraper.scrapeArticles(articles, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraping-progress', progress);
      }
    });
    const failedDetails = [];

    for (const article of scrapedResults) {
      if (article.skipped) {
        if (article.reason === 'paid') {
          logger.updateStats('skipped_paid');
        } else {
          logger.updateStats('skipped_error');
        }

        await logger.warn('Skipped article', {
          title: article.title || 'unknown',
          reason: article.reason,
          url: article.url,
          error: article.error || ''
        });

        if (article.reason === 'error') {
          const detail = {
            stage: 'scrape',
            title: article.title || 'unknown',
            url: article.url || '',
            reason: article.reason,
            error: article.error || '抓取阶段发生未知错误'
          };
          failedDetails.push(detail);
          sendStatus(
            `抓取失败：${detail.title} -> ${detail.error}`,
            'error'
          );
        } else {
          sendStatus(
            `已跳过文章：${article.title || 'unknown'} (${article.reason})`,
            'warn'
          );
        }
        continue;
      }

      try {
        const imageMapping = [];

        const filePath = await fileManager.generateUniqueFilePath(article, format);

        if (format === 'pdf') {
          const pdfResult = await converter.toPDF(article, imageMapping, filePath);
          if (!pdfResult.success) {
            throw new Error(pdfResult.error || 'PDF 生成失败');
          }
        } else {
          const markdown = await converter.toMarkdown(article, imageMapping);
          const saveResult = await fileManager.saveFile(filePath, markdown);
          if (!saveResult.success) {
            throw new Error(saveResult.error || 'Markdown 保存失败');
          }
        }

        logger.updateStats('scraped');
        await logger.info('Exported article', {
          title: article.title,
          filePath
        });

        sendStatus(`已保存：${article.title}`, 'success');
      } catch (error) {
        logger.updateStats('skipped_error');
        const detail = {
          stage: 'export',
          title: article.title || 'unknown',
          url: article.url || '',
          reason: 'export_error',
          error: error.message || '导出阶段发生未知错误'
        };
        failedDetails.push(detail);

        await logger.error('Failed to export article', {
          title: article.title,
          error: error.message
        });
        sendStatus(`导出失败：${detail.title} -> ${detail.error}`, 'error');
      }
    }

    await logger.printSummary();
    const stats = {
      ...logger.getStats(),
      failedDetails
    };
    sendStatus('导出任务完成', 'success');

    return {
      success: true,
      stats
    };
  } catch (error) {
    if (logger) {
      await logger.error('Scraping pipeline failed', { error: error.message });
    }
    sendStatus(`导出失败：${error.message}`, 'error');
    return { success: false, error: error.message };
  } finally {
    isScraping = false;
    if (activeScrapeMode === 'manual') {
      activeScrapeMode = null;
    }
    stopMemoryMonitor();
  }
});

ipcMain.handle('stop-scraping', async () => {
  clearAutoResumeTimer();

  if (scraper) {
    scraper.stop();
  }
  if (activeScrapeMode === 'full') {
    sendStatus('已请求停止全量导出，正在保存进度', 'warn');
  } else if (activeScrapeMode === 'incremental') {
    incrementalStopRequested = true;
    sendStatus('已请求停止增量同步，正在等待任务收尾', 'warn');
  } else {
    sendStatus('已请求停止，正在等待当前任务收尾', 'warn');
  }
  return { success: true };
});

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths.length) {
    return { success: false };
  }

  return {
    success: true,
    path: result.filePaths[0]
  };
});

ipcMain.handle('get-stats', async () => {
  if (!logger) {
    return { success: false };
  }

  return {
    success: true,
    stats: logger.getStats()
  };
});

let runtimeGuardsInstalled = false;

function installRuntimeGuards() {
  if (runtimeGuardsInstalled) {
    return;
  }
  runtimeGuardsInstalled = true;

  process.on('unhandledRejection', async (reason) => {
    const errorText = reason instanceof Error
      ? `${reason.message}\n${reason.stack || ''}`
      : String(reason);

    try {
      if (logger) {
        await logger.error('Unhandled rejection in main process', { error: errorText });
      }
      await markActiveFullExportTaskAsInterrupted(`主进程未处理 Promise 拒绝：${errorText}`);
    } catch (error) {
      // ignore guard errors
    }

    sendStatus('检测到主进程未处理异常，任务可能已中断，请查看日志', 'error');
  });

  process.on('uncaughtException', async (error) => {
    const errorText = error && error.stack
      ? error.stack
      : (error && error.message ? error.message : String(error));

    try {
      if (logger) {
        await logger.error('Uncaught exception in main process', { error: errorText });
      }
      await markActiveFullExportTaskAsInterrupted(`主进程未捕获异常：${errorText}`);
    } catch (guardError) {
      // ignore guard errors
    }

    sendStatus('检测到主进程未捕获异常，任务已中断，请查看日志', 'error');
  });
}

app.whenReady().then(async () => {
  await initializeServices();
  installRuntimeGuards();
  createWindow();
});

app.on('window-all-closed', async () => {
  if (isScraping) {
    if (logger) {
      await logger.warn('All windows were closed while scraping is still running', {
        activeMode: activeScrapeMode || 'none',
        activeTaskId: activeFullExportTaskId || ''
      });
    }

    setTimeout(() => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    }, 300);
    return;
  }

  if (process.platform !== 'darwin') {
    clearAutoResumeTimer();
    stopMemoryMonitor();
    stopIncrementalScheduler();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

