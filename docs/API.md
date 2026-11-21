# 给机器人递一张状态卡

Status姬提供五个只读查询接口，适合接入机器人、脚本或自己的仪表盘。完整示例也可以直接在后台「接口文档」复制。

## 先拿好通行证

登录后台生成访问 Token，将其放进请求头：

```http
Authorization: Bearer YOUR_TOKEN
```

也支持 `X-API-Key: YOUR_TOKEN`。密钥明文只在生成时显示一次；重新生成后旧密钥立即失效。健康检查无需密钥，其他四个接口都需要。

| 方法 | 地址 | 会收到什么 |
| --- | --- | --- |
| GET | `/api/v1/health` | 本监控进程的健康状态与运行时间 |
| GET | `/api/v1/status` | 服务总览、分类、历史检查与域名状态 |
| GET | `/api/v1/status/{id}` | 一个已启用服务的状态，ID 从总览中获取 |
| GET | `/api/v1/events` | 故障和恢复事件，含故障持续时长 |
| GET | `/api/v1/alerts` | 当前服务故障、证书和域名到期风险 |

## 一封简单的请求

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://status.example.com/api/v1/status
```

PowerShell：

```powershell
$token = "YOUR_TOKEN"
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "https://status.example.com/api/v1/events?limit=20" -Headers $headers
```

时间字符串为 ISO 8601 UTC。`latency` 和 `durationMs` 的单位是毫秒，`uptime` 的单位是秒。未检查的服务为 `unknown`；事件中的 `durationMs: null` 表示尚未恢复或没有记录时长，请勿显示为零秒。

## 轮询事件时

`/api/v1/events` 支持：

| 参数 | 含义 |
| --- | --- |
| `limit` | 返回数量，默认 20，范围 1–100 |
| `since` | 仅返回发生时间晚于此时间的事件，使用 ISO 8601 字符串 |

结果按发生时间从新到旧返回，最多检索最近 200 条。它没有完整历史的游标分页；轮询时请按事件 ID 去重，保留一点时间重叠，并确保事件量没有超过单次查询范围。

建议每 30–60 秒请求一次。v1 接口按 IP 合计每分钟最多 120 次；429 时按 `Retry-After` 延迟重试。401 表示密钥缺失或无效；404 表示服务不存在或未启用；网络错误或 5xx 时逐步延长重试间隔。

`/api/v1/health` 只说明监控进程可以响应，并不代表所有被监控目标正常。

## 完整字段

导入 [OpenAPI 3 定义](../public/openapi.json) 即可查看参数、响应结构与示例。生产接入请使用 HTTPS，并把 Token 保存在可信后端。
