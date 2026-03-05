const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const COS = require('cos-nodejs-sdk-v5');
const crypto = require('crypto');
const fetch = require('node-fetch');

class ImageProcessor {
  constructor(cosConfig, retryTimes = 3, timeout = 30000) {
    this.retryTimes = retryTimes;
    this.timeout = timeout;

    this.bucket = cosConfig.bucket;
    this.region = cosConfig.region;
    this.prefix = cosConfig.prefix || 'wechat-articles';
    this.enabled = Boolean(
      cosConfig &&
      cosConfig.enabled &&
      cosConfig.secretId &&
      cosConfig.secretKey &&
      this.bucket &&
      this.region
    );

    this.cos = this.enabled
      ? new COS({
        SecretId: cosConfig.secretId,
        SecretKey: cosConfig.secretKey
      })
      : null;
  }

  isAvailable() {
    return this.enabled;
  }

  ensureAvailable() {
    if (!this.enabled || !this.cos) {
      throw new Error('COS 未配置，无法上传图片');
    }
  }

  async downloadImage(url) {
    const response = await fetch(url, { timeout: this.timeout });

    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const buffer = await response.buffer();

    let ext = '.jpg';
    const contentType = response.headers.get('content-type');
    if (contentType) {
      if (contentType.includes('png')) ext = '.png';
      else if (contentType.includes('gif')) ext = '.gif';
      else if (contentType.includes('webp')) ext = '.webp';
      else if (contentType.includes('svg')) ext = '.svg';
    }

    const tempPath = path.join(os.tmpdir(), `wechat_img_${Date.now()}${ext}`);
    await fs.writeFile(tempPath, buffer);

    return tempPath;
  }

  async uploadImage(localPath, retryCount = 0) {
    this.ensureAvailable();

    if (!(await fs.pathExists(localPath))) {
      throw new Error(`Image file not found: ${localPath}`);
    }

    const ext = path.extname(localPath);
    const hash = crypto
      .createHash('md5')
      .update(localPath + Date.now())
      .digest('hex');
    const key = `${this.prefix}/${hash}${ext}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Upload timeout'));
      }, this.timeout);

      this.cos.putObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
          Body: fs.createReadStream(localPath)
        },
        async (err) => {
          clearTimeout(timeoutId);

          if (err) {
            if (retryCount < this.retryTimes) {
              try {
                const retried = await this.uploadImage(localPath, retryCount + 1);
                resolve(retried);
              } catch (retryError) {
                reject(retryError);
              }
            } else {
              reject(err);
            }
            return;
          }

          resolve(`https://${this.bucket}.cos.${this.region}.myqcloud.com/${key}`);
        }
      );
    });
  }

  async processArticleImages(imageUrls) {
    if (!this.isAvailable()) {
      return imageUrls.map((url) => ({
        originalUrl: url,
        success: false,
        skipped: true,
        error: 'COS 未配置'
      }));
    }

    const results = [];

    for (const url of imageUrls) {
      let tempPath = null;

      try {
        tempPath = await this.downloadImage(url);
        const cosUrl = await this.uploadImage(tempPath);
        results.push({ originalUrl: url, cosUrl, success: true });
      } catch (error) {
        results.push({ originalUrl: url, error: error.message, success: false });
      } finally {
        if (tempPath && (await fs.pathExists(tempPath))) {
          await fs.remove(tempPath);
        }
      }
    }

    return results;
  }

  async processImages(imagePaths) {
    const results = [];

    for (const imagePath of imagePaths) {
      try {
        const url = await this.uploadImage(imagePath);
        results.push({ path: imagePath, url, success: true });
      } catch (error) {
        results.push({ path: imagePath, error: error.message, success: false });
      }
    }

    return results;
  }
}

module.exports = ImageProcessor;
