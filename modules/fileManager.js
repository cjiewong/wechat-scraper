const fs = require('fs-extra');
const path = require('path');

class FileManager {
  constructor(outputDir) {
    this.outputDir = outputDir;
  }

  resolveArticleDate(article) {
    const candidates = [
      article.publishTimestamp ? new Date(Number(article.publishTimestamp) * 1000) : null,
      article.updateTime ? new Date(Number(article.updateTime) * 1000) : null,
      article.date ? new Date(article.date) : null
    ].filter(Boolean);

    for (const item of candidates) {
      if (!Number.isNaN(item.getTime())) {
        return item;
      }
    }

    return new Date();
  }

  generateFilePath(article, format) {
    const date = this.resolveArticleDate(article);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const safeTitle = this.sanitizeFileName(article.title || 'untitled');
    const maxTitleLength = 64;
    const truncatedTitle =
      safeTitle.length > maxTitleLength ? safeTitle.slice(0, maxTitleLength) : safeTitle;

    const dirPath = path.join(this.outputDir, String(year), `${month}月`);
    const fileName = `${month}-${day}_${truncatedTitle}.${format}`;

    return path.join(dirPath, fileName);
  }

  sanitizeFileName(fileName) {
    return String(fileName)
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .trim() || 'untitled';
  }

  async saveFile(filePath, content) {
    try {
      await fs.ensureDir(path.dirname(filePath));

      if (Buffer.isBuffer(content)) {
        await fs.writeFile(filePath, content);
      } else {
        await fs.writeFile(filePath, content, 'utf-8');
      }

      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async fileExists(filePath) {
    return fs.pathExists(filePath);
  }

  async generateUniqueFilePath(article, format) {
    let filePath = this.generateFilePath(article, format);

    if (!(await this.fileExists(filePath))) {
      return filePath;
    }

    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    let counter = 1;
    while (await this.fileExists(filePath)) {
      filePath = path.join(dir, `${baseName}_${counter}${ext}`);
      counter += 1;
    }

    return filePath;
  }

  async saveProgress(progressData) {
    const progressFile = path.join(this.outputDir, '.scraper-progress.json');
    await fs.writeJson(progressFile, progressData, { spaces: 2 });
  }

  async loadProgress() {
    const progressFile = path.join(this.outputDir, '.scraper-progress.json');

    if (await fs.pathExists(progressFile)) {
      return fs.readJson(progressFile);
    }

    return null;
  }

  async clearProgress() {
    const progressFile = path.join(this.outputDir, '.scraper-progress.json');

    if (await fs.pathExists(progressFile)) {
      await fs.remove(progressFile);
    }
  }
}

module.exports = FileManager;
