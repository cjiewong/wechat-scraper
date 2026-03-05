const fetch = require('node-fetch');
const cheerio = require('cheerio');

class ArticleScraper {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.stopped = false;
    this.session = {
      token: '',
      cookie: '',
      userAgent: config.scraper.defaultUserAgent
    };
  }

  stop() {
    this.stopped = true;
  }

  resetStopFlag() {
    this.stopped = false;
  }

  setSession(session = {}) {
    const cookie = this.normalizeCookie(session.cookie || '');
    const tokenFromCookie = this.extractTokenFromCookie(cookie);

    this.session = {
      token: String(session.token || tokenFromCookie || '').trim(),
      cookie,
      userAgent: String(session.userAgent || this.config.scraper.defaultUserAgent || '').trim()
    };

    return this.getSession();
  }

  getSession() {
    return { ...this.session };
  }

  normalizeCookie(cookieValue) {
    if (!cookieValue) {
      return '';
    }

    if (Array.isArray(cookieValue)) {
      return cookieValue
        .map((item) => `${item.name}=${item.value}`)
        .join('; ')
        .trim();
    }

    return String(cookieValue)
      .trim()
      .replace(/;+\s*$/g, '');
  }

  extractTokenFromCookie(cookieString) {
    if (!cookieString) {
      return '';
    }

    const match = cookieString.match(/(?:^|;\s*)token=([^;]+)/i);
    return match ? String(match[1]).trim() : '';
  }

  ensureSession() {
    if (!this.session.cookie) {
      throw new Error('缺少 Cookie，请先配置微信公众号后台登录态');
    }

    if (!this.session.token) {
      throw new Error('缺少 token，请先配置微信公众号后台 token');
    }
  }

  buildHeaders(referer = 'https://mp.weixin.qq.com/') {
    this.ensureSession();

    return {
      Cookie: this.session.cookie,
      'User-Agent': this.session.userAgent,
      Referer: referer,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
  }

  async validateSession() {
    this.ensureSession();

    const homeUrl = `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=${encodeURIComponent(this.session.token)}`;
    const response = await fetch(homeUrl, {
      method: 'GET',
      timeout: this.config.scraper.timeout,
      headers: this.buildHeaders('https://mp.weixin.qq.com/')
    });

    if (!response.ok) {
      throw new Error(`登录状态检测失败：HTTP ${response.status}`);
    }

    const finalUrl = response.url || homeUrl;
    const html = await response.text();

    if (finalUrl.includes('loginpage') || html.includes('微信公众平台登录')) {
      throw new Error('登录态已失效，请重新扫码登录并更新 Cookie / token');
    }

    return {
      valid: true,
      homeUrl: finalUrl
    };
  }

  async requestJSON(path, params, referer, options = {}) {
    this.ensureSession();

    const url = new URL(`https://mp.weixin.qq.com${path}`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });

    const maxRet200013Retries = Math.max(
      0,
      Number(options.maxRet200013Retries ?? this.config.scraper.maxFrequencyRetries ?? 3)
    );
    const baseBackoffMs = Math.max(
      300,
      Number(options.ret200013BackoffMs ?? this.config.scraper.frequencyBackoffMs ?? 3000)
    );
    let attempt = 0;

    while (true) {
      const response = await fetch(url.toString(), {
        method: 'GET',
        timeout: this.config.scraper.timeout,
        headers: this.buildHeaders(referer)
      });

      const rawText = await response.text();
      let data = null;

      try {
        data = JSON.parse(rawText);
      } catch (error) {
        if (rawText.includes('登录') || rawText.includes('invalid session')) {
          throw new Error('登录态已失效，请重新配置 token / Cookie');
        }
        throw new Error('微信公众号接口返回非 JSON 数据，可能已触发风控');
      }

      const retCode = data?.base_resp?.ret;
      const errMsg = data?.base_resp?.err_msg || '';

      if (retCode === 0 || retCode === undefined) {
        return data;
      }

      if (retCode === 200003) {
        throw new Error('登录态无效（ret=200003），请重新登录公众号平台');
      }

      if (retCode === 200013) {
        if (attempt < maxRet200013Retries) {
          const sleepMs = Math.round(baseBackoffMs * (2 ** attempt));
          await this.logger.warn('Frequency control hit, backing off before retry', {
            path,
            attempt: attempt + 1,
            maxRetries: maxRet200013Retries,
            sleepMs
          });
          await this.sleep(sleepMs);
          attempt += 1;
          continue;
        }
        throw new Error('请求过于频繁（ret=200013），请稍后重试');
      }

      throw new Error(`微信接口错误：${errMsg || '未知错误'} (ret=${retCode})`);
    }
  }

  async searchAccounts(keyword, limit = 10, offset = 0) {
    if (!keyword || !keyword.trim()) {
      return [];
    }

    const data = await this.requestJSON(
      '/cgi-bin/searchbiz',
      {
        action: 'search_biz',
        begin: offset,
        count: limit,
        query: keyword.trim(),
        token: this.session.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: 1
      },
      `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=${encodeURIComponent(this.session.token)}`
    );

    const list = Array.isArray(data.list) ? data.list : [];

    const accounts = list.map((item) => {
      const articleCountCandidates = [
        item.article_num,
        item.article_count,
        item.appmsg_cnt,
        item.total_count,
        item.msg_cnt,
        item.send_num
      ];
      const articleCountRaw = articleCountCandidates.find((value) => {
        const normalized = Number(value);
        return Number.isFinite(normalized) && normalized >= 0;
      });

      return {
        id: item.fakeid || item.user_name,
        fakeid: item.fakeid,
        userName: item.user_name || item.alias || '',
        name: item.nickname || item.alias || '未知公众号',
        alias: item.alias || '',
        intro: item.signature || '',
        avatar: item.round_head_img || item.img || '',
        articleCount: articleCountRaw === undefined ? null : Number(articleCountRaw),
        verifyType: item.verify_type || item.verify_status || 0,
        serviceType: item.service_type || 0
      };
    });

    // searchbiz 在部分账号上不再返回文章总数，补充调用 appmsgpublish 获取 total_count。
    // 为避免触发频控，仅探测前 6 个缺失计数的账号。
    const hasValidCount = (value) => {
      if (value === null || value === undefined || value === '') {
        return false;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0;
    };

    const missingCountAccounts = accounts.filter(
      (item) => item && item.fakeid && !hasValidCount(item.articleCount)
    );
    const probeTargets = missingCountAccounts.slice(0, 6);

    for (const account of probeTargets) {
      try {
        const counted = await this.fetchAccountArticleCount(account.fakeid);
        if (Number.isFinite(counted) && counted >= 0) {
          account.articleCount = counted;
        }
      } catch (error) {
        // 忽略单账号计数失败，不影响搜索主流程
      }
    }

    return accounts;
  }

  async fetchAccountArticleCount(fakeid) {
    if (!fakeid) {
      return null;
    }

    const data = await this.requestJSON(
      '/cgi-bin/appmsgpublish',
      {
        sub: 'list',
        sub_action: 'list_ex',
        begin: 0,
        count: 1,
        fakeid,
        token: this.session.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: 1
      },
      `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?token=${encodeURIComponent(this.session.token)}&lang=zh_CN`
    );

    const publishPage = this.decodeMaybeJson(data.publish_page) || {};
    const candidates = [
      publishPage.total_count,
      publishPage.publish_count,
      publishPage.masssend_count,
      publishPage.featured_count
    ];

    const value = candidates.find((item) => {
      const parsed = Number(item);
      return Number.isFinite(parsed) && parsed >= 0;
    });

    return value === undefined ? null : Number(value);
  }

  decodeMaybeJson(value) {
    if (!value) {
      return null;
    }

    if (typeof value === 'object') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  htmlDecode(value) {
    if (!value) {
      return '';
    }

    return String(value)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  normalizeArticleUrl(url) {
    if (!url) {
      return '';
    }

    const decoded = this.htmlDecode(url.trim());

    if (decoded.startsWith('//')) {
      return `https:${decoded}`;
    }

    if (decoded.startsWith('/')) {
      return `https://mp.weixin.qq.com${decoded}`;
    }

    return decoded;
  }

  extractArticleId(link, fallbackId = '') {
    if (!link) {
      return fallbackId || `${Date.now()}`;
    }

    const match = link.match(/\/s\/([^?&#]+)/i);
    if (match && match[1]) {
      return match[1];
    }

    try {
      const parsed = new URL(link);
      const mid = parsed.searchParams.get('mid');
      const idx = parsed.searchParams.get('idx');
      const sn = parsed.searchParams.get('sn');
      if (mid && idx && sn) {
        return `${mid}_${idx}_${sn}`;
      }
    } catch (error) {
      // ignore URL parse error
    }

    return fallbackId || `${Date.now()}`;
  }

  normalizeArticleRecord(rawArticle) {
    const url = this.normalizeArticleUrl(rawArticle.link || rawArticle.url || '');
    const publishTime = Number(rawArticle.update_time || rawArticle.create_time || 0);

    return {
      id: String(this.extractArticleId(url, rawArticle.aid || rawArticle.id || '')),
      aid: rawArticle.aid || '',
      title: this.htmlDecode(rawArticle.title || '未命名文章'),
      digest: this.htmlDecode(rawArticle.digest || ''),
      url,
      cover: this.normalizeArticleUrl(rawArticle.cover || rawArticle.cover_url || ''),
      date: publishTime > 0 ? new Date(publishTime * 1000).toISOString() : '',
      updateTime: publishTime
    };
  }

  inDateRange(article, startDate, endDate) {
    if (!startDate && !endDate) {
      return true;
    }

    if (!article.updateTime) {
      return true;
    }

    const articleTime = article.updateTime * 1000;
    const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
    const end = endDate ? new Date(`${endDate}T23:59:59`).getTime() : null;

    if (Number.isFinite(start) && articleTime < start) {
      return false;
    }

    if (Number.isFinite(end) && articleTime > end) {
      return false;
    }

    return true;
  }

  async getArticleList(options = {}) {
    const {
      fakeid,
      startDate,
      endDate,
      maxPages = this.config.scraper.defaultMaxPages,
      pageSize = this.config.scraper.defaultPageSize
    } = options;

    if (!fakeid) {
      throw new Error('缺少 fakeid，无法获取公众号文章列表');
    }

    this.resetStopFlag();
    const allArticles = [];

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (this.stopped) {
        break;
      }

      const begin = pageIndex * pageSize;
      const data = await this.requestJSON(
        '/cgi-bin/appmsgpublish',
        {
          sub: 'list',
          sub_action: 'list_ex',
          begin,
          count: pageSize,
          fakeid,
          token: this.session.token,
          lang: 'zh_CN',
          f: 'json',
          ajax: 1
        },
        `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?token=${encodeURIComponent(this.session.token)}&lang=zh_CN`
      );

      const publishPage = this.decodeMaybeJson(data.publish_page);
      if (!publishPage || !Array.isArray(publishPage.publish_list) || publishPage.publish_list.length === 0) {
        break;
      }

      for (const publishItem of publishPage.publish_list) {
        const publishInfo = this.decodeMaybeJson(publishItem.publish_info);
        if (!publishInfo) {
          continue;
        }

        const articles = publishInfo.appmsgex || publishInfo.appmsg || [];
        for (const article of articles) {
          const normalized = this.normalizeArticleRecord(article);
          if (normalized.url && this.inDateRange(normalized, startDate, endDate)) {
            allArticles.push(normalized);
          }
        }
      }

      if (publishPage.publish_list.length < pageSize) {
        break;
      }
    }

    allArticles.sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));

    const deduped = [];
    const seen = new Set();
    for (const item of allArticles) {
      const key = item.id || item.url;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    }

    await this.logger.info('Loaded article list from mp API', {
      fakeid,
      total: deduped.length,
      maxPages,
      pageSize,
      startDate,
      endDate
    });

    return deduped;
  }

  toAbsoluteUrl(rawUrl, baseUrl) {
    if (!rawUrl) {
      return '';
    }

    const decoded = this.htmlDecode(rawUrl.trim());

    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }

    if (decoded.startsWith('//')) {
      return `https:${decoded}`;
    }

    try {
      const url = new URL(decoded, baseUrl || 'https://mp.weixin.qq.com');
      return url.toString();
    } catch (error) {
      return decoded;
    }
  }

  detectPaidArticle(textContent, contentLength) {
    if (!textContent) {
      return false;
    }

    const compact = textContent.replace(/\s+/g, '');
    const hasPayHint =
      compact.includes('付费阅读') ||
      compact.includes('付费内容') ||
      compact.includes('会员可见') ||
      compact.includes('赞赏后可阅读');

    return hasPayHint && contentLength < 900;
  }

  normalizeText(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  escapeHtml(raw) {
    return String(raw || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  decodeJsEscapedString(raw) {
    if (!raw) {
      return '';
    }

    return String(raw)
      .replace(/\\x([0-9a-fA-F]{2})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\'/g, '\'')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  deepHtmlDecode(raw, rounds = 3) {
    let current = String(raw || '');
    for (let i = 0; i < rounds; i += 1) {
      const next = this.htmlDecode(current);
      if (next === current) {
        break;
      }
      current = next;
    }
    return current;
  }

  extractJsDecodeValues(html, key) {
    if (!html || !key) {
      return [];
    }

    const regex = new RegExp(`${key}\\s*:\\s*JsDecode\\('((?:\\\\.|[^'\\\\])*)'\\)`, 'g');
    const values = [];
    let match = regex.exec(html);
    while (match) {
      const decoded = this.deepHtmlDecode(this.decodeJsEscapedString(match[1]));
      if (decoded && decoded.trim()) {
        values.push(decoded.trim());
      }
      match = regex.exec(html);
    }

    return values;
  }

  extractNumericField(html, key) {
    if (!html || !key) {
      return 0;
    }

    const pattern = new RegExp(`${key}\\s*:\\s*'?(\\d{9,})'?\\s*(?:\\*\\s*1)?`);
    const match = html.match(pattern);
    if (!match || !match[1]) {
      return 0;
    }

    const value = Number(match[1]);
    return Number.isFinite(value) ? value : 0;
  }

  pickLongest(values = []) {
    if (!Array.isArray(values) || values.length === 0) {
      return '';
    }

    return values
      .slice()
      .sort((a, b) => (b ? b.length : 0) - (a ? a.length : 0))[0] || '';
  }

  pickFirstNonEmpty(values = [], minLength = 1) {
    if (!Array.isArray(values) || values.length === 0) {
      return '';
    }

    for (const raw of values) {
      const value = String(raw || '').trim();
      if (value.length >= minLength) {
        return value;
      }
    }

    return '';
  }

  extractCgiDataContext(html) {
    const full = String(html || '');
    const start = full.indexOf('window.cgiDataNew');
    if (start < 0) {
      return full;
    }

    const scriptEnd = full.indexOf('</script>', start);
    if (scriptEnd > start) {
      return full.slice(start, scriptEnd);
    }

    const hardLimit = Math.min(full.length, start + 800000);
    return full.slice(start, hardLimit);
  }

  renderCgiContentToHtml(contentText) {
    const normalized = String(contentText || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    if (!normalized) {
      return '';
    }

    const hasBlockLevelHtml = /<\/?(?:p|div|section|article|main|header|footer|aside|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|figure|figcaption|hr|br|img)\b/i.test(normalized);
    if (hasBlockLevelHtml) {
      return normalized;
    }

    const hasInlineHtml = /<[^>]+>/.test(normalized);

    const paragraphs = normalized
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) {
      const singleLine = hasInlineHtml ? normalized : this.escapeHtml(normalized);
      return `<p>${singleLine.replace(/\n/g, '<br>')}</p>`;
    }

    return paragraphs
      .map((paragraph) => {
        const segment = hasInlineHtml ? paragraph : this.escapeHtml(paragraph);
        return `<p>${segment.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');
  }

  extractContentFromCgiData(html, articleUrl) {
    const cgiContext = this.extractCgiDataContext(html);

    const contentCandidates = [
      ...this.extractJsDecodeValues(cgiContext, 'content_noencode'),
      ...this.extractJsDecodeValues(cgiContext, 'content')
    ];
    const contentRaw = this.pickFirstNonEmpty(contentCandidates, 80) || this.pickLongest(contentCandidates);
    if (!contentRaw) {
      return null;
    }

    const contentHtml = this.renderCgiContentToHtml(contentRaw);
    if (!contentHtml) {
      return null;
    }

    const titleCandidates = this.extractJsDecodeValues(cgiContext, 'title')
      .map((item) => this.normalizeText(item))
      .filter((item) => item && item.length <= 180 && !item.includes('http://') && !item.includes('https://'));
    const title = this.pickFirstNonEmpty(titleCandidates, 2);

    const authorCandidates = [
      ...this.extractJsDecodeValues(cgiContext, 'author'),
      ...this.extractJsDecodeValues(cgiContext, 'nick_name')
    ]
      .map((item) => this.normalizeText(item))
      .filter((item) => item && item.length <= 40 && !item.includes('http://') && !item.includes('https://'));
    const author = this.pickFirstNonEmpty(authorCandidates, 1);

    const createTimeCandidates = this.extractJsDecodeValues(cgiContext, 'create_time')
      .map((item) => this.normalizeText(item))
      .filter((item) => /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(item));
    const createTime = this.pickFirstNonEmpty(createTimeCandidates, 8);

    const publishTs = this.extractNumericField(cgiContext, 'ori_create_time')
      || this.extractNumericField(cgiContext, 'svr_time')
      || this.extractNumericField(cgiContext, 'ori_send_time');

    const parsed = cheerio.load(`<div id="cgi_text_root">${contentHtml}</div>`, { decodeEntities: false });
    const images = [];
    parsed('#cgi_text_root img').each((_, element) => {
      const src = parsed(element).attr('src') || '';
      const resolved = this.toAbsoluteUrl(src, articleUrl);
      if (resolved && !resolved.startsWith('data:') && !images.includes(resolved)) {
        images.push(resolved);
      }
    });

    let publishTime = createTime || '';
    if (!publishTime && publishTs) {
      publishTime = new Date(publishTs * 1000).toLocaleString('zh-CN', { hour12: false });
    }

    return {
      title,
      author,
      date: publishTime,
      content: parsed('#cgi_text_root').html() || contentHtml,
      images,
      text: this.normalizeText(parsed('#cgi_text_root').text()),
      strategy: 'cgiData'
    };
  }

  isInteractionOverlayText(text, html) {
    const compact = this.normalizeText(text);
    if (!compact) {
      return false;
    }

    const strongMarkers = [
      '轻触查看原文',
      '向上滑动看下一个',
      '微信扫一扫可打开此内容',
      '请长按识别二维码',
      '点击卡片关注',
      '轻点两下取消赞',
      '轻点两下取消在看'
    ];

    const weakMarkers = [
      '微信扫一扫',
      '使用小程序',
      '视频 小程序 赞',
      '视频小程序赞',
      'javascript:void'
    ];

    const strongHits = strongMarkers.filter((item) => compact.includes(item)).length;
    const weakHits = weakMarkers.filter((item) => compact.includes(item)).length;
    const compactLength = compact.length;
    const paragraphCount = (String(html || '').match(/<p[\s>]/g) || []).length;
    const lineBreakCount = (String(html || '').match(/<br\s*\/?>/g) || []).length;

    if (compact.includes('轻点两下取消赞') && compact.includes('轻点两下取消在看')) {
      return true;
    }

    if (strongHits >= 1 && compactLength <= 420 && paragraphCount <= 6) {
      return true;
    }

    if (weakHits >= 2 && compactLength <= 260 && paragraphCount <= 3 && lineBreakCount <= 10) {
      return true;
    }

    return false;
  }

  detectUnavailablePage(html) {
    const text = this.normalizeText(html);
    if (!text) {
      return '';
    }

    const rules = [
      { keyword: '当前环境异常', message: '文章详情请求被风控拦截，请稍后重试' },
      { keyword: '该内容已被发布者删除', message: '文章已被发布者删除' },
      { keyword: '此内容因违规无法查看', message: '文章因违规无法查看' },
      { keyword: '内容已被删除', message: '文章内容不可访问（可能已删除）' },
      { keyword: '轻点两下取消赞 在看，轻点两下取消在看', message: '文章详情页仅返回互动壳内容（疑似删除或风控）' },
      { keyword: '请在微信客户端打开链接', message: '该文章需在微信客户端内打开' },
      { keyword: '访问过于频繁', message: '访问过于频繁，请稍后重试' }
    ];

    const hit = rules.find((rule) => text.includes(rule.keyword));
    return hit ? hit.message : '';
  }

  pickBestContentRoot($) {
    const selectorPriority = [
      '#js_content',
      '.rich_media_content',
      '#img-content',
      '.article-content',
      '.entry-content',
      '.post-content',
      '[data-role="article-content"]',
      'article',
      'main article',
      'main .content'
    ];

    for (const selector of selectorPriority) {
      const nodes = $(selector);
      for (let i = 0; i < nodes.length; i += 1) {
        const current = nodes.eq(i);
        const text = this.normalizeText(current.text());
        const html = current.html() || '';
        if (text.length >= 80 || html.length >= 220) {
          return { root: current, strategy: `selector:${selector}` };
        }
      }
    }

    let bestRoot = null;
    let bestScore = 0;

    $('article, main, section, div').each((_, node) => {
      const candidate = $(node);
      const text = this.normalizeText(candidate.text());
      if (text.length < 120) {
        return;
      }

      const pCount = candidate.find('p').length;
      const imgCount = candidate.find('img').length;
      let linkTextLength = 0;
      candidate.find('a').each((__, anchor) => {
        linkTextLength += this.normalizeText($(anchor).text()).length;
      });

      const htmlLength = (candidate.html() || '').length;
      const linkRatio = text.length > 0 ? linkTextLength / text.length : 0;
      const score = text.length + pCount * 28 + imgCount * 90 + htmlLength * 0.08 - linkRatio * 220;

      if (score > bestScore) {
        bestScore = score;
        bestRoot = candidate;
      }
    });

    if (bestRoot && bestScore >= 260) {
      return { root: bestRoot, strategy: 'heuristic' };
    }

    const jsArticle = $('#js_article').first();
    const jsArticleTextLength = this.normalizeText(jsArticle.text()).length;
    if (jsArticle.length && jsArticleTextLength < 40) {
      return { root: null, strategy: 'none:empty_js_article' };
    }

    const body = $('body').first();
    if (body.length) {
      const bodyText = this.normalizeText(body.text());
      if (bodyText.length >= 120) {
        return { root: body, strategy: 'fallback:body' };
      }
    }

    return { root: null, strategy: 'none' };
  }

  cleanupContentRoot(contentRoot, strategy) {
    // clone 避免污染原始文档节点
    const cleaned = contentRoot.clone();
    cleaned.find('script, style, noscript, template').remove();
    cleaned.find('#wx_expand_article, #unlogin_bottom_bar, #js_stream_bottom_bar, #wx_expand_slidetip').remove();
    cleaned.find('.wx_expand_article, .stream_bottom_bar_wrp, .wx_follow_context, .wx_stream_article_slide_tip').remove();
    cleaned.find('button, input, textarea, select').remove();
    cleaned.find('a[href^="javascript:"]').remove();
    cleaned.find('.js_uneditable, .js_editor_audio, .js_ad_link, .rich_media_tool, .original_area_primary').remove();

    if (strategy === 'fallback:body' || strategy === 'heuristic') {
      cleaned.find('header, footer, nav, aside').remove();
      cleaned.find('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
    }

    return cleaned;
  }

  async fetchArticleContent(article) {
    if (this.stopped) {
      throw new Error('已停止抓取');
    }

    const articleUrl = typeof article === 'string' ? article : article.url;
    if (!articleUrl) {
      throw new Error('文章 URL 为空');
    }

    const response = await fetch(articleUrl, {
      method: 'GET',
      timeout: this.config.scraper.timeout,
      headers: {
        ...this.buildHeaders('https://mp.weixin.qq.com/'),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`获取文章详情失败：HTTP ${response.status}`);
    }

    const html = await response.text();
    const unavailableReason = this.detectUnavailablePage(html);
    if (unavailableReason) {
      throw new Error(unavailableReason);
    }

    const cgiDataContent = this.extractContentFromCgiData(html, articleUrl);
    const $ = cheerio.load(html, { decodeEntities: false });
    const { root, strategy } = this.pickBestContentRoot($);

    let contentRoot = null;
    let finalStrategy = strategy;
    if (root && root.length) {
      contentRoot = this.cleanupContentRoot(root, strategy);
    }

    const title =
      $('#activity-name').first().text().trim() ||
      $('.rich_media_title').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').first().text().trim() ||
      this.htmlDecode(article.title || '未命名文章');

    const author =
      $('#js_name').first().text().trim() ||
      $('#js_author_name').first().text().trim() ||
      $('.rich_media_meta_text').first().text().trim() ||
      '';

    const publishTime =
      $('#publish_time').first().text().trim() ||
      (article.date ? new Date(article.date).toLocaleString('zh-CN') : '');

    let finalTitle = title;
    let finalAuthor = author;
    let finalPublishTime = publishTime;

    let contentHtml = '';
    let contentText = '';
    let images = [];

    if (contentRoot && contentRoot.length) {
      contentRoot.find('img').each((_, element) => {
        const $img = $(element);
        const source = $img.attr('data-src') || $img.attr('src') || '';
        const resolved = this.toAbsoluteUrl(source, articleUrl);
        if (resolved) {
          $img.attr('src', resolved);
          if (!images.includes(resolved) && !resolved.startsWith('data:')) {
            images.push(resolved);
          }
        }
      });

      contentHtml = contentRoot.html() || '';
      contentText = this.normalizeText(contentRoot.text());
    }

    const overlayLooksLikeShell = this.isInteractionOverlayText(contentText, contentHtml);
    const domLooksInvalid = !contentRoot
      || !contentRoot.length
      || !contentText
      || contentHtml.length < 80
      || overlayLooksLikeShell;

    const cgiLooksStrong = Boolean(
      cgiDataContent &&
      cgiDataContent.text &&
      cgiDataContent.text.length >= 120 &&
      !this.isInteractionOverlayText(cgiDataContent.text, cgiDataContent.content)
    );

    const shouldPreferCgi = Boolean(
      cgiLooksStrong &&
      (
        domLooksInvalid ||
        strategy === 'fallback:body' ||
        strategy === 'none' ||
        strategy.startsWith('none:') ||
        cgiDataContent.text.length >= contentText.length * 0.9
      )
    );

    if (shouldPreferCgi) {
      contentHtml = cgiDataContent.content;
      contentText = cgiDataContent.text;
      images = cgiDataContent.images;
      finalStrategy = cgiDataContent.strategy;

      finalTitle = cgiDataContent.title || finalTitle;
      finalAuthor = cgiDataContent.author || finalAuthor;
      finalPublishTime = cgiDataContent.date || finalPublishTime;
    } else if (cgiDataContent) {
      finalTitle = finalTitle || cgiDataContent.title;
      finalAuthor = finalAuthor || cgiDataContent.author;
      finalPublishTime = finalPublishTime || cgiDataContent.date;
    }

    const isPaid = this.detectPaidArticle(contentText, contentHtml.length);
    if (isPaid) {
      return {
        skipped: true,
        reason: 'paid',
        url: articleUrl,
        title: finalTitle || article.title || '未命名文章'
      };
    }

    const strategyLooksWeak = strategy === 'fallback:body'
      || strategy === 'heuristic'
      || strategy === 'none'
      || strategy.startsWith('none:');

    if (overlayLooksLikeShell && strategyLooksWeak && !shouldPreferCgi) {
      await this.logger.warn('Rejected suspicious shell-like article body', {
        url: articleUrl,
        strategy: finalStrategy,
        textLength: contentText.length,
        htmlLength: contentHtml.length
      });
      throw new Error(`正文疑似互动壳页，未提取到有效正文（strategy=${finalStrategy}）`);
    }

    if (!contentText || contentHtml.length < 80) {
      throw new Error(`正文内容过短，可能被反爬拦截或页面结构特殊（strategy=${finalStrategy}）`);
    }

    return {
      skipped: false,
      title: finalTitle,
      author: finalAuthor,
      date: finalPublishTime,
      content: contentHtml,
      images,
      url: articleUrl,
      publishTimestamp: article.updateTime || 0,
      extractionStrategy: finalStrategy
    };
  }

  async scrapeArticle(article) {
    try {
      const result = await this.fetchArticleContent(article);
      if (!result.skipped) {
        await this.logger.info('Scraped article content', {
          title: result.title,
          images: result.images.length,
          extractionStrategy: result.extractionStrategy || 'unknown'
        });
      }
      return result;
    } catch (error) {
      await this.logger.error('Failed to scrape article', {
        title: article?.title || '',
        url: article?.url || '',
        error: error.message
      });

      return {
        skipped: true,
        reason: 'error',
        error: error.message,
        url: article?.url || '',
        title: article?.title || ''
      };
    }
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async scrapeArticles(articles, onProgress) {
    this.resetStopFlag();

    const list = Array.isArray(articles) ? articles : [];
    const results = [];

    for (let index = 0; index < list.length; index++) {
      if (this.stopped) {
        await this.logger.warn('Scraping stopped by user');
        break;
      }

      const article = list[index];
      if (typeof onProgress === 'function') {
        onProgress({
          current: index + 1,
          total: list.length,
          article: article.title || article.url || '未知文章',
          percentage: Math.round(((index + 1) / list.length) * 100)
        });
      }

      const scraped = await this.scrapeArticle(article);
      results.push(scraped);

      if (index < list.length - 1) {
        await this.sleep(this.config.scraper.delayBetweenArticles);
      }
    }

    return results;
  }
}

module.exports = ArticleScraper;
