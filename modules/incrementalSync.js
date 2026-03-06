const fs = require('fs-extra');
const path = require('path');
const FileManager = require('./fileManager');

const DEFAULT_RUNTIME = {
  incrementalDays: 7,
  pageSize: 10,
  maxPagesPerRun: 20,
  delayBetweenArticlesMs: 1500,
  delayBetweenPagesMs: 2500,
  delayBetweenTargetsMs: 6000,
  requestTimeoutMs: 30000,
  maxFrequencyRetries: 6,
  frequencyBackoffMs: 5000
};

function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch (_error) {
    return 'Asia/Shanghai';
  }
}

function makeDefaultConfig() {
  return {
    version: 1,
    scheduler: {
      enabled: false,
      dailyTime: '08:30',
      timezone: defaultTimezone(),
      lastTriggeredDate: '',
      lastRunAt: '',
      lastStatus: 'idle',
      lastMessage: ''
    },
    runtime: {
      ...DEFAULT_RUNTIME
    },
    targets: []
  };
}

function sanitizeKey(raw) {
  return String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128) || 'unknown';
}

function sanitizePathLike(raw) {
  return String(raw || '').trim();
}

function isValidDailyTime(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));
}

function ensurePositiveInt(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} 必须是大于 0 的整数`);
  }
  return normalized;
}

function ensureNonNegativeNumber(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${fieldName} 必须是大于等于 0 的数字`);
  }
  return normalized;
}

function normalizeTarget(target, index) {
  if (!target || typeof target !== 'object') {
    throw new Error(`targets[${index}] 不是对象`);
  }

  const fakeid = String(target.fakeid || '').trim();
  const accountName = String(target.accountName || '').trim();
  const outputDir = sanitizePathLike(target.outputDir);
  const format = String(target.format || 'md').toLowerCase();
  const enabled = target.enabled !== false;

  if (!fakeid) {
    throw new Error(`targets[${index}].fakeid 不能为空`);
  }
  if (!accountName) {
    throw new Error(`targets[${index}].accountName 不能为空`);
  }
  if (!outputDir || !path.isAbsolute(outputDir)) {
    throw new Error(`targets[${index}].outputDir 必须是绝对路径`);
  }
  if (!['md', 'pdf'].includes(format)) {
    throw new Error(`targets[${index}].format 必须是 md 或 pdf`);
  }

  return {
    id: String(target.id || `inc-${sanitizeKey(fakeid)}`),
    accountName,
    fakeid,
    outputDir: path.resolve(outputDir),
    format,
    enabled,
    lastRunAt: String(target.lastRunAt || ''),
    lastStatus: String(target.lastStatus || 'never'),
    lastSummary: target.lastSummary && typeof target.lastSummary === 'object'
      ? {
          fetched: Number(target.lastSummary.fetched || 0),
          exported: Number(target.lastSummary.exported || 0),
          skippedExisting: Number(target.lastSummary.skippedExisting || 0),
          skippedPaid: Number(target.lastSummary.skippedPaid || 0),
          failed: Number(target.lastSummary.failed || 0)
        }
      : {
          fetched: 0,
          exported: 0,
          skippedExisting: 0,
          skippedPaid: 0,
          failed: 0
        },
    lastError: String(target.lastError || '')
  };
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = makeDefaultConfig();

  const scheduler = {
    ...defaults.scheduler,
    ...(source.scheduler && typeof source.scheduler === 'object' ? source.scheduler : {})
  };

  if (!isValidDailyTime(scheduler.dailyTime)) {
    throw new Error('scheduler.dailyTime 必须是 HH:mm 格式');
  }

  const runtimeRaw = source.runtime && typeof source.runtime === 'object'
    ? source.runtime
    : {};

  const runtime = {
    incrementalDays: ensurePositiveInt(
      runtimeRaw.incrementalDays === undefined ? defaults.runtime.incrementalDays : runtimeRaw.incrementalDays,
      'runtime.incrementalDays'
    ),
    pageSize: ensurePositiveInt(
      runtimeRaw.pageSize === undefined ? defaults.runtime.pageSize : runtimeRaw.pageSize,
      'runtime.pageSize'
    ),
    maxPagesPerRun: ensurePositiveInt(
      runtimeRaw.maxPagesPerRun === undefined ? defaults.runtime.maxPagesPerRun : runtimeRaw.maxPagesPerRun,
      'runtime.maxPagesPerRun'
    ),
    delayBetweenArticlesMs: ensureNonNegativeNumber(
      runtimeRaw.delayBetweenArticlesMs === undefined ? defaults.runtime.delayBetweenArticlesMs : runtimeRaw.delayBetweenArticlesMs,
      'runtime.delayBetweenArticlesMs'
    ),
    delayBetweenPagesMs: ensureNonNegativeNumber(
      runtimeRaw.delayBetweenPagesMs === undefined ? defaults.runtime.delayBetweenPagesMs : runtimeRaw.delayBetweenPagesMs,
      'runtime.delayBetweenPagesMs'
    ),
    delayBetweenTargetsMs: ensureNonNegativeNumber(
      runtimeRaw.delayBetweenTargetsMs === undefined ? defaults.runtime.delayBetweenTargetsMs : runtimeRaw.delayBetweenTargetsMs,
      'runtime.delayBetweenTargetsMs'
    ),
    requestTimeoutMs: ensurePositiveInt(
      runtimeRaw.requestTimeoutMs === undefined ? defaults.runtime.requestTimeoutMs : runtimeRaw.requestTimeoutMs,
      'runtime.requestTimeoutMs'
    ),
    maxFrequencyRetries: ensurePositiveInt(
      runtimeRaw.maxFrequencyRetries === undefined ? defaults.runtime.maxFrequencyRetries : runtimeRaw.maxFrequencyRetries,
      'runtime.maxFrequencyRetries'
    ),
    frequencyBackoffMs: ensureNonNegativeNumber(
      runtimeRaw.frequencyBackoffMs === undefined ? defaults.runtime.frequencyBackoffMs : runtimeRaw.frequencyBackoffMs,
      'runtime.frequencyBackoffMs'
    )
  };

  const targetsRaw = Array.isArray(source.targets) ? source.targets : [];
  const targets = targetsRaw.map((item, index) => normalizeTarget(item, index));
  const fakeidSet = new Set();
  for (const item of targets) {
    if (fakeidSet.has(item.fakeid)) {
      throw new Error(`targets 中 fakeid 重复：${item.fakeid}`);
    }
    fakeidSet.add(item.fakeid);
  }

  return {
    version: 1,
    scheduler: {
      enabled: Boolean(scheduler.enabled),
      dailyTime: String(scheduler.dailyTime),
      timezone: String(scheduler.timezone || defaults.scheduler.timezone),
      lastTriggeredDate: String(scheduler.lastTriggeredDate || ''),
      lastRunAt: String(scheduler.lastRunAt || ''),
      lastStatus: String(scheduler.lastStatus || 'idle'),
      lastMessage: String(scheduler.lastMessage || '')
    },
    runtime,
    targets
  };
}

async function ensureConfigDir(configPath) {
  await fs.ensureDir(path.dirname(configPath));
}

async function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  await ensureConfigDir(resolvedPath);

  if (!(await fs.pathExists(resolvedPath))) {
    const defaults = makeDefaultConfig();
    await fs.writeJson(resolvedPath, defaults, { spaces: 2 });
    return defaults;
  }

  try {
    const raw = await fs.readJson(resolvedPath);
    return normalizeConfig(raw);
  } catch (_error) {
    const defaults = makeDefaultConfig();
    await fs.writeJson(resolvedPath, defaults, { spaces: 2 });
    return defaults;
  }
}

async function saveConfig(configPath, config) {
  const resolvedPath = path.resolve(configPath);
  const normalized = normalizeConfig(config);
  await ensureConfigDir(resolvedPath);
  await fs.writeJson(resolvedPath, normalized, { spaces: 2 });
  return normalized;
}

function nowYmdLocal() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resolveIncrementalDateRange(incrementalDays) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (Math.max(1, Number(incrementalDays || 1)) - 1));

  const format = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  return {
    startDate: format(start),
    endDate: format(end)
  };
}

function sleep(ms) {
  const safeMs = Number(ms || 0);
  if (!Number.isFinite(safeMs) || safeMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

async function loadManifest(outputDir) {
  const manifestPath = path.join(outputDir, '.wechat-export-manifest.json');
  if (!(await fs.pathExists(manifestPath))) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: {}
    };
  }

  try {
    const payload = await fs.readJson(manifestPath);
    return {
      version: 1,
      updatedAt: payload.updatedAt || new Date().toISOString(),
      items: payload.items && typeof payload.items === 'object' ? payload.items : {}
    };
  } catch (_error) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: {}
    };
  }
}

async function saveManifest(outputDir, manifest) {
  const manifestPath = path.join(outputDir, '.wechat-export-manifest.json');
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

async function writeFailureReport(target, failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return '';
  }

  const manager = new FileManager(target.outputDir);
  const filePath = path.join(
    target.outputDir,
    `failed-articles-${manager.sanitizeFileName(target.fakeid)}.json`
  );

  await fs.writeJson(
    filePath,
    {
      fakeid: target.fakeid,
      accountName: target.accountName,
      exportedAt: new Date().toISOString(),
      totalFailures: failures.length,
      failures
    },
    { spaces: 2 }
  );

  return filePath;
}

function buildScraperConfig(baseConfig, runtime) {
  return {
    ...baseConfig,
    scraper: {
      ...baseConfig.scraper,
      timeout: runtime.requestTimeoutMs,
      delayBetweenArticles: runtime.delayBetweenArticlesMs,
      delayBetweenPages: runtime.delayBetweenPagesMs,
      defaultPageSize: runtime.pageSize,
      defaultMaxPages: runtime.maxPagesPerRun,
      maxFrequencyRetries: runtime.maxFrequencyRetries,
      frequencyBackoffMs: runtime.frequencyBackoffMs
    }
  };
}

async function runIncrementalTarget(target, runtime, deps) {
  const {
    scraper,
    converter,
    logger,
    baseScraperConfig,
    shouldStop,
    onProgress
  } = deps;

  await fs.ensureDir(target.outputDir);
  const dateRange = resolveIncrementalDateRange(runtime.incrementalDays);
  const manager = new FileManager(target.outputDir);
  const manifest = await loadManifest(target.outputDir);
  const failures = [];

  scraper.config = buildScraperConfig(baseScraperConfig, runtime);

  const summary = {
    accountName: target.accountName,
    fakeid: target.fakeid,
    format: target.format,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    fetched: 0,
    exported: 0,
    skippedExisting: 0,
    skippedPaid: 0,
    failed: 0,
    stopped: false
  };

  await logger.info('Start incremental target sync', {
    accountName: target.accountName,
    fakeid: target.fakeid,
    outputDir: target.outputDir,
    format: target.format,
    dateRange
  });

  const articles = await scraper.getArticleList({
    fakeid: target.fakeid,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    maxPages: runtime.maxPagesPerRun,
    pageSize: runtime.pageSize
  });

  summary.fetched = articles.length;
  if (typeof onProgress === 'function') {
    onProgress({
      type: 'target-indexed',
      target,
      summary,
      totalArticles: articles.length
    });
  }

  for (let index = 0; index < articles.length; index += 1) {
    if (shouldStop && shouldStop()) {
      summary.stopped = true;
      break;
    }

    const article = articles[index];
    const articleKey = article.id || article.url;
    if (!articleKey) {
      continue;
    }

    const expectedFilePath = manager.generateFilePath(article, target.format);
    if (manifest.items[articleKey] || (await manager.fileExists(expectedFilePath))) {
      summary.skippedExisting += 1;
      if (!manifest.items[articleKey]) {
        manifest.items[articleKey] = {
          title: article.title || '',
          url: article.url || '',
          filePath: expectedFilePath,
          exportedAt: new Date().toISOString(),
          updateTime: Number(article.updateTime || 0)
        };
      }
      continue;
    }

    const scraped = await scraper.scrapeArticle(article);
    if (scraped.skipped) {
      if (scraped.reason === 'paid') {
        summary.skippedPaid += 1;
      } else {
        summary.failed += 1;
      }

      failures.push({
        stage: 'scrape',
        id: articleKey,
        title: scraped.title || article.title || '',
        url: scraped.url || article.url || '',
        error: scraped.error || scraped.reason || '抓取失败'
      });
      continue;
    }

    try {
      const filePath = await manager.generateUniqueFilePath(scraped, target.format);
      if (target.format === 'pdf') {
        const pdfResult = await converter.toPDF(scraped, [], filePath);
        if (!pdfResult.success) {
          throw new Error(pdfResult.error || 'PDF 生成失败');
        }
      } else {
        const markdown = await converter.toMarkdown(scraped, []);
        const saved = await manager.saveFile(filePath, markdown);
        if (!saved.success) {
          throw new Error(saved.error || 'Markdown 保存失败');
        }
      }

      summary.exported += 1;
      manifest.items[articleKey] = {
        title: scraped.title || article.title || '',
        url: scraped.url || article.url || '',
        filePath,
        exportedAt: new Date().toISOString(),
        updateTime: Number(article.updateTime || 0)
      };
    } catch (error) {
      summary.failed += 1;
      await logger.error('Failed to export incremental article', {
        accountName: target.accountName,
        fakeid: target.fakeid,
        format: target.format,
        title: scraped.title || article.title || '',
        url: scraped.url || article.url || '',
        error: error.message || String(error)
      });
      failures.push({
        stage: 'export',
        id: articleKey,
        title: scraped.title || article.title || '',
        url: scraped.url || article.url || '',
        error: error.message || '导出失败'
      });
    }

    if (typeof onProgress === 'function') {
      onProgress({
        type: 'target-progress',
        target,
        summary,
        current: index + 1,
        total: articles.length,
        article: article.title || ''
      });
    }

    await sleep(runtime.delayBetweenArticlesMs);
  }

  await saveManifest(target.outputDir, manifest);
  const reportPath = await writeFailureReport(target, failures);

  const result = {
    summary,
    failureCount: failures.length,
    reportPath
  };

  await logger.info('Finished incremental target sync', {
    accountName: target.accountName,
    fakeid: target.fakeid,
    ...summary,
    failureCount: failures.length,
    reportPath
  });

  return result;
}

async function runIncrementalBatch(config, deps) {
  const { logger, shouldStop, onProgress } = deps;
  const startedAt = new Date().toISOString();
  const enabledTargets = config.targets.filter((item) => item.enabled);
  const summaries = [];

  for (let i = 0; i < enabledTargets.length; i += 1) {
    if (shouldStop && shouldStop()) {
      break;
    }

    const target = enabledTargets[i];
    if (typeof onProgress === 'function') {
      onProgress({
        type: 'target-start',
        target,
        index: i + 1,
        totalTargets: enabledTargets.length
      });
    }

    try {
      const result = await runIncrementalTarget(target, config.runtime, deps);
      summaries.push({
        targetId: target.id,
        fakeid: target.fakeid,
        accountName: target.accountName,
        ...result
      });
    } catch (error) {
      await logger.error('Incremental target failed', {
        accountName: target.accountName,
        fakeid: target.fakeid,
        error: error.message || String(error)
      });
      summaries.push({
        targetId: target.id,
        fakeid: target.fakeid,
        accountName: target.accountName,
        summary: {
          accountName: target.accountName,
          fakeid: target.fakeid,
          format: target.format,
          fetched: 0,
          exported: 0,
          skippedExisting: 0,
          skippedPaid: 0,
          failed: 1,
          stopped: false
        },
        failureCount: 1,
        reportPath: '',
        fatalError: error.message || String(error)
      });
    }

    await sleep(config.runtime.delayBetweenTargetsMs);
  }

  const total = summaries.reduce(
    (acc, item) => {
      const summary = item.summary || {};
      acc.fetched += Number(summary.fetched || 0);
      acc.exported += Number(summary.exported || 0);
      acc.skippedExisting += Number(summary.skippedExisting || 0);
      acc.skippedPaid += Number(summary.skippedPaid || 0);
      acc.failed += Number(summary.failed || 0);
      return acc;
    },
    {
      fetched: 0,
      exported: 0,
      skippedExisting: 0,
      skippedPaid: 0,
      failed: 0
    }
  );

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    date: nowYmdLocal(),
    totalTargets: enabledTargets.length,
    summaries,
    total,
    stopped: Boolean(shouldStop && shouldStop())
  };
}

function createTargetFromAccount(options) {
  const {
    fakeid = '',
    accountName = '',
    outputDir = '',
    format = 'md'
  } = options || {};

  const fakeidValue = String(fakeid).trim();
  const accountNameValue = String(accountName).trim();
  const outputDirValue = sanitizePathLike(outputDir);
  const formatValue = String(format || 'md').toLowerCase();

  if (!fakeidValue) {
    throw new Error('缺少 fakeid');
  }
  if (!accountNameValue) {
    throw new Error('缺少 accountName');
  }
  if (!outputDirValue || !path.isAbsolute(outputDirValue)) {
    throw new Error('outputDir 必须是绝对路径');
  }
  if (!['md', 'pdf'].includes(formatValue)) {
    throw new Error('format 必须是 md 或 pdf');
  }

  return {
    id: `inc-${sanitizeKey(fakeidValue)}`,
    accountName: accountNameValue,
    fakeid: fakeidValue,
    outputDir: path.resolve(outputDirValue),
    format: formatValue,
    enabled: true,
    lastRunAt: '',
    lastStatus: 'never',
    lastSummary: {
      fetched: 0,
      exported: 0,
      skippedExisting: 0,
      skippedPaid: 0,
      failed: 0
    },
    lastError: ''
  };
}

module.exports = {
  DEFAULT_RUNTIME,
  makeDefaultConfig,
  normalizeConfig,
  loadConfig,
  saveConfig,
  runIncrementalBatch,
  resolveIncrementalDateRange,
  createTargetFromAccount
};
