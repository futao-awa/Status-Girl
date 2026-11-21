# 音乐扫码连接

网易云使用网易云音乐 APP 扫码并确认。汽水音乐当前官方二维码提示使用**已登录的抖音 APP**验证身份，请按二维码对应页面的提示操作。登录成功后，后台会自动更新连接状态，无需手动刷新。

二维码确认与账号资料查询是两个步骤。只有本次扫码取得的会话凭据保存成功，页面才显示「已连接」；头像或歌单加载慢不会撤销已保存的登录。网易云的 `MUSIC_A` 是匿名凭据，不能代表账号已登录。

## 实现参考

本次对照了以下公开项目的请求协议与响应结构，保留 Status姬自己的实现：

| 项目 | 对照内容 | 参考版本 |
| --- | --- | --- |
| [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) · MIT | `login_qr_key`、`login_qr_check` 的 `type=3`，同一请求身份与 Cookie，账号资料使用 weapi POST | [`23d9e9d`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tree/23d9e9d7ee5dfeccfc3b15916ccd9da1f76d3ea4) |
| [guowenye/qishui-api](https://github.com/guowenye/qishui-api) · MIT | Passport 表单字段、创建二维码时的 Cookie、确认后的 Set-Cookie 与适配器 `auth.sessionid` | [`e409c10`](https://github.com/guowenye/qishui-api/tree/e409c10fe7441a10d370da7da61d62bbc1e5126c) |
| [myedunote/meting-api](https://github.com/myedunote/meting-api) · 声明 MIT | PC Passport 参数、官方 BDMS 签名、请求追踪及授权 Cookie | [`d21ac70`](https://github.com/myedunote/meting-api/tree/d21ac706f96a84ff8baa659f7d21092416bdb897) |

汽水 Passport 请求使用 PC SDK `2.4.13 / normal` 参数，与歌曲接口的 `/luna/pc` 参数分开。创建和检查二维码共用设备、安装标识及 Cookie；显示官方原始二维码，保留官方登录链接。原生状态 `1 / 2 / 3 / 4` 分别表示等待、已扫码、已确认、已过期；适配器也可以返回对应的状态字符串。

## Linux 直接部署

服务器只需要 Node.js 22+ 和项目现有依赖，**无需安装 Chromium、Chrome、Python 或额外音乐服务**。在后台点击扫码后，当前浏览器会按需加载汽水官方 BDMS `1.0.0.41` 安全组件，为创建和检查请求计算 `a_bogus` 签名；Node.js 负责发送请求、收集授权 Cookie 并保存连接。

安全组件运行在独立沙盒中，不能访问后台的 Cookie、账号或持久化存储。它接收待签名的扫码请求，不接收音乐登录凭据；服务器只接受与原请求、当前管理员和本次签名编号一致的结果。取消扫码、退出平台或切换平台后，旧请求不能重新登录。

扫码期间保持后台页面打开。浏览器需要能访问官方组件域名 `lf-c-flwb.bytetos.com` 或备用域名 `lf-headquarters-speed.yhgfb-cn-static.com`，服务器需要能访问官方音乐接口。组件加载失败会显示提示，可调整网络后重新生成二维码。项目不分发第三方压缩 SDK 源码。

## 异常提示

- 扫码后短暂返回等待状态时，页面继续显示「已扫码」或「正在授权」。
- 确认接口下发有效会话后立即保留登录，避免后续 API 根地址的 404 落地页误报失败。尚未取得会话时，授权跳转逐步收集 Cookie；回调暂时失败会继续重试该回调。
- 汽水错误 `7` 会等待 5 秒再检查；错误 `2046` 表示平台要求额外身份验证，页面会提示在 APP 完成验证后重新扫码。
- HTTP 错误、异常状态和非 JSON 响应会显示平台及错误码，不会伪装成「等待扫码」。诊断信息不包含 Cookie、会话或二维码 token。

`MUSIC_API_BASE_URL` 留空使用内置直连。自建汽水适配服务应兼容 `/auth/qrcode`（GET）、`/auth/qrcode/status`（POST）、`/auth/me`（POST）与 `/me/playlists`（POST）。网易云适配服务应兼容 `/login/qr/key`、`/login/qr/create`、`/login/qr/check` 和 `/user/account`。

## 验证范围

`npm test` 包含本地 HTTP 完整流程测试：检查实际加密请求和表单、Cookie 传递、确认后的保存与重新读取、授权跳转重试，以及前端提示。测试数据在独立临时目录中，不能代表官方账号已完成手机确认。

2026-11-21 两家平台均已通过真实手机扫码确认，取得登录会话并成功查询账号资料。汽水验证使用本项目的后台浏览器沙盒签名与 Node.js 请求，确认接口返回 `status=confirmed / error_code=0` 并下发 `sessionid`；后续 `/luna/pc/me` 成功返回账号资料。诊断会话只保存在独立测试内存中，未替换用户配置。

平台风控、额外身份验证和账号播放权限以官方结果为准。错误 `2046` 的平台验证窗口尚未集成；遇到该情况时按页面提示在官方 APP 完成验证后重新扫码。
