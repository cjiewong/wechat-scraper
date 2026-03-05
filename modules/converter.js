const TurndownService = require('turndown');
const { BrowserWindow } = require('electron');
const fs = require('fs-extra');

class ContentConverter {
  constructor() {
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
    });

    this.turndownService.addRule('images', {
      filter: 'img',
      replacement: (_content, node) => {
        const src = node.getAttribute('data-src') || node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        return src ? `![${alt}](${src})` : '';
      }
    });
  }

  applyImageMapping(content, imageMapping) {
    if (!content || !Array.isArray(imageMapping) || imageMapping.length === 0) {
      return content;
    }

    let next = content;
    for (const mapping of imageMapping) {
      if (mapping.success && mapping.cosUrl) {
        const regex = new RegExp(this.escapeRegExp(mapping.originalUrl), 'g');
        next = next.replace(regex, mapping.cosUrl);
      }
    }

    return next;
  }

  async toMarkdown(article, imageMapping) {
    let markdown = `# ${article.title}\n\n`;
    markdown += `**作者**: ${article.author || '未知'}\n\n`;
    markdown += `**发布时间**: ${article.date || '未知'}\n\n`;
    if (article.url) {
      markdown += `**原文链接**: ${article.url}\n\n`;
    }
    markdown += `---\n\n`;

    const withMappedImages = this.applyImageMapping(article.content || '', imageMapping);
    markdown += this.turndownService.turndown(withMappedImages);

    return markdown;
  }

  async toPDF(article, imageMapping, outputPath) {
    const html = this.buildHTMLForPDF(article, imageMapping);

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true
      }
    });

    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const pdfData = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: {
          top: 1,
          bottom: 1,
          left: 1,
          right: 1
        }
      });

      await fs.writeFile(outputPath, pdfData);
      return { success: true, outputPath };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      win.close();
    }
  }

  buildHTMLForPDF(article, imageMapping) {
    const content = this.applyImageMapping(article.content || '', imageMapping);

    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${article.title}</title>
  <style>
    body {
      font-family: "Noto Serif SC", "Source Han Serif SC", "Microsoft YaHei", sans-serif;
      line-height: 1.7;
      color: #232b2f;
      max-width: 880px;
      margin: 0 auto;
      padding: 28px;
    }
    h1 {
      font-size: 30px;
      margin-bottom: 12px;
      border-bottom: 2px solid #16697a;
      padding-bottom: 12px;
    }
    .meta {
      color: #4a5a63;
      font-size: 14px;
      margin-bottom: 22px;
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 18px auto;
      border-radius: 4px;
    }
    p {
      margin: 14px 0;
    }
    a {
      color: #0f5f8a;
    }
    pre {
      background: #f3f5f6;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
    }
    code {
      background: #f3f5f6;
      padding: 2px 4px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <h1>${article.title}</h1>
  <div class="meta">
    <p><strong>作者</strong>: ${article.author || '未知'}</p>
    <p><strong>发布时间</strong>: ${article.date || '未知'}</p>
    ${article.url ? `<p><strong>原文链接</strong>: ${article.url}</p>` : ''}
  </div>
  <hr>
  <div class="content">${content}</div>
</body>
</html>
    `;
  }

  escapeRegExp(string) {
    return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = ContentConverter;
