# 记账本

一个跑在手机浏览器里的**本地记账 PWA**，单式记账、收支都记、两级分类、月支出预算帽、分类占比与趋势报表。数据全部存本机（IndexedDB），不上传任何服务器。

## 功能

- **记一笔**：3 秒完成，默认今天日期、金额大键盘、常用分类、账户标签、选填备注。
- **两级分类**：预置 9 大支出类 + 5 大收入类及常用子类，全部可增删改（图标 / 颜色 / 归属）。
- **账户标签**：微信 / 支付宝 / 现金 / 银行卡 / 信用卡，可自定义。
- **月预算帽**：设一个每月支出上限，进度条 80% 变黄、超支变红（只提醒，不拦截）。
- **统计报表**：本月/上月/近3月/今年/全部 的收支结余、日均支出、分类占比环形图、支出趋势柱状图。
- **明细**：按日期分组，支持类型/分类/账户/月份筛选，可编辑、复制、删除。
- **数据安全**：JSON 全量备份与恢复、CSV 明细导出（Excel 可打开）。

## 目录结构

```
├── index.html          入口页
├── manifest.json       PWA 清单
├── sw.js               Service Worker（离线缓存）
├── css/style.css       样式
├── js/
│   ├── app.js          主逻辑
│   ├── db.js           IndexedDB 封装
│   ├── seed.js         默认分类/账户
│   ├── charts.js       ECharts 图表封装
│   └── util.js         工具函数
├── vendor/echarts.min.js  本地图表库
├── icons/              App 图标
└── scripts/generate_icons.py  图标生成脚本
```

## 本地运行

本项目使用 ES Module，本地测试需通过 http 服务（并保证 `.js` 返回正确 MIME）：

```bash
# 推荐：内置服务（已正确处理 MIME）
node scripts/serve.js
# 或
npx serve .
```

然后手机/电脑访问 `http://localhost:8000`。**注意**：`file://` 直接打开可正常记账，但「添加到主屏 + 离线」能力需要 https/localhost；Windows 上 `python -m http.server` 会把 `.js` 当 `text/plain` 返回导致模块加载失败，不建议用它测试本项目。

## 部署到 GitHub Pages（推荐，获得完整 PWA 体验）

1. 新建 GitHub 仓库，推送本目录。
2. 仓库 `Settings → Pages`，Source 选 `main` 分支根目录，保存。
3. 得到网址如 `https://你的用户名.github.io/仓库名/`。
4. 手机 Chrome/Edge 打开该网址 → 菜单 →「添加到主屏幕」，即可像 App 一样全屏、离线使用。

## 数据与备份

- 数据存在浏览器 IndexedDB 中，**清理浏览器数据会丢失**，请定期用「设置 → 导出备份（JSON）」保存。
- 换设备：旧设备导出 JSON，新设备导入即可恢复全部数据。
- 首次使用会预置一套默认分类和账户，之后可自由修改。

## 重新生成图标（可选）

```bash
python scripts/generate_icons.py
```
