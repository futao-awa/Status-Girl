# Status姬 项目约定

本仓库维护 Status姬的 Node.js / Express 后端和原生 HTML、CSS、JavaScript 前端。

- 需要 Node.js 22+；安装使用 `npm ci`，开发使用 `npm run dev`，检查使用 `npm test`。
- 正式源码位于 `server.js`、`src/` 和 `public/`，测试位于 `tests/`，部署文档位于 `docs/`。
- 保持现有玻璃风格和页面布局；未经用户要求，不重做项目介绍页结构或改写其简介。
- 运行时只展示真实监控结果。文档演示应使用隔离且明确标注的示例数据。
- 保留现有用户配置；不要为演示、测试或重命名覆盖自定义站点名称、账号或音乐登录态。
- 不提交 `data/`、`.env`、凭据、`node_modules/`、参考视频或临时测试输出；使用选择性暂存并检查差异。
- 提交信息采用 `<type>(<scope>): <简述>`；推送、发布或改写远程历史须有用户明确授权。
- 发布时同步包版本、锁文件、OpenAPI 和 CHANGELOG，标签采用 `v<版本号>`。
