// 日志记录模块 - 调整版（适应文章抓取场景）
const fs = require('fs-extra');
const path = require('path');

class Logger {
  constructor(logDir = './logs') {
    this.logDir = logDir;
    this.logFile = path.join(logDir, `scraper-${this.getTimestamp()}.log`);
    this.errorFile = path.join(logDir, 'errors.log');
    this.stats = {
      total: 0,           // 总文章数
      scraped: 0,         // 成功抓取
      skippedPaid: 0,     // 跳过付费文章
      skippedError: 0,    // 错误跳过
      imagesUploaded: 0,  // 上传图片数
      errors: []          // 错误详情
    };
    this.installStdioGuard();
  }

  installStdioGuard() {
    if (Logger._stdioGuardInstalled) {
      return;
    }

    const swallowPipeError = (error) => {
      if (!error) {
        return;
      }

      const code = error.code;
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        return;
      }
    };

    try {
      if (process.stdout && typeof process.stdout.on === 'function') {
        process.stdout.on('error', swallowPipeError);
      }
      if (process.stderr && typeof process.stderr.on === 'function') {
        process.stderr.on('error', swallowPipeError);
      }
    } catch (error) {
      // ignore stdio guard install failures
    }

    Logger._stdioGuardInstalled = true;
  }

  // 在部分 Windows/Electron 启动方式下，stdout/stderr 可能不可写（EPIPE）。
  // 这里统一做容错，避免日志输出导致主进程崩溃。
  safeConsoleWrite(line, isError = false) {
    // 默认仅写文件日志，避免 Electron GUI 环境下 stdout/stderr 断开触发 EPIPE。
    if (process.env.WECHAT_SCRAPER_CONSOLE_LOG !== '1') {
      return;
    }

    const stream = isError ? process.stderr : process.stdout;
    if (!stream || stream.destroyed || stream.writable === false) {
      return;
    }

    try {
      stream.write(`${line}\n`, (error) => {
        if (!error) {
          return;
        }
        const code = error.code;
        if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
          return;
        }
      });
    } catch (error) {
      const code = error && error.code;
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        return;
      }
      // 其他控制台输出异常也不影响主流程
    }
  }

  async init() {
    await fs.ensureDir(this.logDir);
  }

  getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
  }

  async log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
    await fs.appendFile(this.logFile, logLine);

    // 错误同时写入错误日志
    if (level === 'ERROR') {
      await fs.appendFile(this.errorFile, logLine);
      this.safeConsoleWrite(logLine.trim(), true);
    } else {
      this.safeConsoleWrite(logLine.trim(), false);
    }
  }

  async info(message, data) {
    await this.log('INFO', message, data);
  }

  async warn(message, data) {
    await this.log('WARN', message, data);
  }

  async error(message, data) {
    await this.log('ERROR', message, data);
    this.stats.errors.push({ message, data, timestamp: new Date().toISOString() });
    if (this.stats.errors.length > 1000) {
      this.stats.errors = this.stats.errors.slice(-1000);
    }
  }

  updateStats(action, count = 1) {
    switch (action) {
      case 'total':
        this.stats.total += count;
        break;
      case 'scraped':
        this.stats.scraped += count;
        break;
      case 'skipped_paid':
        this.stats.skippedPaid += count;
        break;
      case 'skipped_error':
        this.stats.skippedError += count;
        break;
      case 'images_uploaded':
        this.stats.imagesUploaded += count;
        break;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  async printSummary() {
    const summary = `
=== 抓取完成 ===
总文章数: ${this.stats.total}
成功抓取: ${this.stats.scraped}
跳过付费文章: ${this.stats.skippedPaid}
错误跳过: ${this.stats.skippedError}
上传图片数: ${this.stats.imagesUploaded}
错误数: ${this.stats.errors.length}
==================
    `;

    await this.info('Scraping Summary', this.stats);
    this.safeConsoleWrite(summary.trim(), false);
  }
}

module.exports = Logger;
