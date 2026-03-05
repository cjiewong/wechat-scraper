const fs = require('fs-extra');
const path = require('path');

const DEFAULT_COS_CONFIG_PATH =
  process.env.WECHAT_SCRAPER_COS_CONFIG ||
  'D:\\project\\obsidian_huaigu\\.obsidian\\plugins\\imgur-tencent-cos\\data.json';

function loadCOSConfig() {
  try {
    const raw = fs.readJsonSync(DEFAULT_COS_CONFIG_PATH);
    const config = {
      secretId: raw.secretId || '',
      secretKey: raw.secretKey || '',
      bucket: raw.bucket || '',
      region: raw.region || '',
      prefix: raw.prefix || 'wechat-articles'
    };

    const enabled = Boolean(
      config.secretId &&
      config.secretKey &&
      config.bucket &&
      config.region
    );

    return {
      ...config,
      enabled,
      sourcePath: DEFAULT_COS_CONFIG_PATH
    };
  } catch (error) {
    return {
      secretId: '',
      secretKey: '',
      bucket: '',
      region: '',
      prefix: 'wechat-articles',
      enabled: false,
      sourcePath: DEFAULT_COS_CONFIG_PATH
    };
  }
}

module.exports = {
  cos: loadCOSConfig(),

  scraper: {
    retryTimes: 3,
    timeout: 30000,
    delayBetweenArticles: 1200,
    defaultPageSize: 5,
    defaultMaxPages: 3,
    maxFrequencyRetries: 3,
    frequencyBackoffMs: 3000,
    defaultUserAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  },

  app: {
    windowWidth: 1520,
    windowHeight: 960,
    minWidth: 1200,
    minHeight: 760,
    title: 'WeChat Scraper Studio'
  },

  storage: {
    sessionPath: path.join(__dirname, '..', 'data', 'session.json')
  }
};
