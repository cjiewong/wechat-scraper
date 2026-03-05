# WeChat Scraper Studio

`wechat-scraper` 已重构为基于 **微信公众平台 API** 的桌面工具，不再依赖搜狗微信页面抓取。

核心接口流程参考微信公众号平台公开接口：
- `https://mp.weixin.qq.com/cgi-bin/searchbiz`（搜索公众号）
- `https://mp.weixin.qq.com/cgi-bin/appmsgpublish`（分页拉取历史文章）

## 主要特性

- 使用公众号后台 `token + Cookie` 直接访问官方接口
- 搜索公众号并按时间范围加载历史文章
- 批量导出文章为 Markdown / PDF
- 图片链接保留与内容导出能力
- 全新的三栏式 UI（会话配置、文章筛选、导出控制）
- 完整导出进度、统计和日志反馈

## 安装与启动

```bash
cd wechat-scraper
npm install
npm start
```

开发模式：

```bash
npm run dev
```

## 使用流程

1. 点击「扫码登录」并在弹窗中完成微信扫码登录（推荐）
2. 登录成功后，应用会自动回填并保存 `token` / `Cookie`
3. 如需手动方式，可点击「打开公众号平台」后自行粘贴会话并保存
4. 点击「检测会话」确认登录态有效
5. 输入公众号名称并搜索，选择目标公众号
6. 设置日期范围、分页参数，点击「加载文章列表」
7. 勾选文章、选择导出目录与格式，点击「开始导出」

## 注意事项

- `token/Cookie` 属于敏感凭据，请仅在本地可信环境使用。
- 公众号接口存在频率限制，建议控制分页与请求频次。
- 导出内容请遵守微信平台规则与原文版权要求。

## 技术栈

- Electron 28
- node-fetch
- cheerio
- Turndown

## GitHub Actions 打包发布

项目已配置工作流：`/.github/workflows/wechat-scraper-release.yml`。

### 触发方式

- 推送版本标签（推荐）：`v*`，例如 `v1.0.1`
- 手动触发：GitHub Actions 页面选择 `wechat-scraper-release` 并执行 `Run workflow`

### 发布步骤（Tag）

```bash
git tag v1.0.1
git push origin v1.0.1
```

### 构建与产物

- Windows: NSIS 安装包（`pack:win`）

工作流会构建 Windows 安装包并上传 Artifacts，然后在同名 Tag 的 GitHub Release 中附加安装包。

### 当前发布策略

- 当前不启用代码签名（未配置证书）
- 后续可按需补充 Windows 签名

## 支持作者

如果这个项目帮你省下了时间，欢迎请我喝一杯奶茶，支持持续维护和功能更新。

![支付宝收款码（请作者喝杯奶茶）](assets/qrCode.jpg)

感谢支持。

## License

MIT

