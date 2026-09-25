# ECHO coturn 迁移记录（2026-08-30）

## 结论

ECHO Demo 使用的 coturn 已从上海 1 核 1G 按量付费 ECS 迁移到北京 2 核 2G 包年包月 ECS。新节点已完成公网 STUN 探测、TURN UDP/TCP 中继回归和 3090 数字人 WebRTC 音视频自检。由于学生账号下的主域名 Worker 无法修改，维护者自己的 Cloudflare 账号已部署一个稳定替代入口。

旧节点暂时保持运行，用于原主域名 Worker 的兼容和紧急回滚。新替代入口不依赖旧 coturn；如果所有 Demo 用户都改用替代入口，旧 ECS 停机不会影响该 Demo，但原主域名的数字人 WebRTC 仍可能受影响。

## 节点信息

| 项目 | 旧节点（回滚） | 新节点（当前 Demo） |
| --- | --- | --- |
| 地域 | 华东 2（上海） | 华北 2（北京） |
| 公网 IP | `47.116.3.151` | `39.102.118.53` |
| 规格 | 1 vCPU / 1 GiB，按量付费 | 2 vCPU / 2 GiB，包年包月 |
| 到期/计费状态 | 即将因欠费停机 | 2027-04-05 到期 |
| TURN 控制端口 | TCP/UDP `3478` | TCP/UDP `3478` |
| UDP relay 范围 | `49152-65535` | `49160-49259` |
| 状态 | 保留运行 | `coturn.service` 已启用并运行 |

新节点内网地址为 `172.16.107.232`，coturn 的公网/内网映射为 `39.102.118.53/172.16.107.232`。认证 realm、用户名和凭据从旧节点原样迁移，但本文不记录任何秘密值。

## 新节点配置与安全组

新节点使用 `/etc/coturn/turnserver.conf`，关键设置如下：

- 长期凭据认证（long-term credential mechanism）和 fingerprint 已启用；
- TCP/UDP TURN 控制端口为 `3478`；
- UDP relay 端口限定为 `49160-49259`，避免开放整个临时端口范围；
- TLS/DTLS 未启用，当前应用使用 `turn:...?...transport=udp`；
- 已移除 `allow-loopback-peers`，降低向本机/内网目标转发的风险；
- CLI 已禁用，服务由 systemd 管理。

安全组 `sg-2ze5t3ra5pc84u961kli` 已添加：

| 协议 | 端口 | 来源 | 用途 |
| --- | --- | --- | --- |
| TCP | `3478` | `0.0.0.0/0` | TURN 控制/兼容 TCP |
| UDP | `3478` | `0.0.0.0/0` | STUN/TURN 控制 |
| UDP | `49160-49259` | `0.0.0.0/0` | TURN relay 媒体 |

配置备份位于新节点：

- `/etc/coturn/turnserver.conf.backup-codex-20260830`
- `/etc/coturn/turnserver.conf.pre-final-cleanup-codex-20260830`

## 应用切换

RTX 3090 上唯一仍引用旧 TURN IP 的活动配置是：

`/home/user/echo/secrets/livetalking.env`

其中 `TURN_SERVER_URL` 已切换为：

`turn:39.102.118.53:3478?transport=udp`

用户名和凭据未改动。切换前备份为：

`/home/user/echo/secrets/livetalking.env.backup-codex-20260830-pre-coturn-migration`

切换后仅重启了加载该文件的服务：

- `echo-livetalking.service`
- `echo-demo-web.service`

`echo-gateway.service`、语音模型和其他 3090 服务未做无关改动。

## 验证结果

1. 新节点 `coturn.service` 为 active，内网地址上的 TCP/UDP `3478` 正常监听。
2. 从公网对新节点执行 STUN Binding，UDP/TCP 均收到成功响应。
3. 从上海 ECS 对北京新节点执行真实 TURN relay 回归：
   - UDP：160/160 条消息收到，0 丢包，平均 RTT 约 25.45 ms；
   - TCP：160/160 条消息收到，0 丢包，平均 RTT 约 50.32 ms。
4. 3090 本机数字人 WebRTC 自检成功：连接状态为 connected，收到 173 帧视频，音频峰值 24988，网关报告 upstream healthy。
5. Demo 公网入口 `https://turtle-while-intellectual-dance.trycloudflare.com/dashboard` 返回 HTTP 200。
6. `https://livetalking.echodigitalpersona.com/health` 返回网关和上游均健康。

## Cloudflare 主域名限制

当前 Wrangler 登录的是项目维护者自己的 Cloudflare 账号。只读检查显示，该账号下不存在名为 `echo-digital-persona` 的 Worker，也没有相关部署记录；`echodigitalpersona.com` 的原 Worker 仍由学生账号控制。因此本次无法更新该 Worker 中可能存在的 `TURN_SERVER_URL` secret，也不能断言主域名的登录用户已收到新 TURN 地址。

这不会影响当前 3090 Demo。若仍需保障原主域名，应保留旧 coturn；若旧机因欠费必须停机，应立即让 Demo 用户改用下面的替代入口。

## 稳定替代入口

维护者自己的 Cloudflare 账号已部署轻量反向代理 Worker：

`https://echo-digital-persona-demo.1910792195.workers.dev`

请求路径如下：

`浏览器 -> workers.dev 代理 -> TryCloudflare 隧道 -> RTX 3090 Web -> 北京 coturn`

代理 Worker 名为 `echo-digital-persona-demo`，首次替代部署版本为 `69811ed4-0652-46cb-a424-9dfd64bc747f`。它不保存应用账号、密码或 TURN 凭据，改写同源重定向和 Cookie 域，并通过 KV 动态选择当前 3090 Web 入口。

3090 的 `/home/user/echo/secrets/demo-web.env` 已设置：

`PUBLIC_APP_ORIGIN=https://echo-digital-persona-demo.1910792195.workers.dev`

备份为：

`/home/user/echo/secrets/demo-web.env.backup-codex-20260830-pre-stable-origin`

验证结果：

- 代理健康接口返回 `ok: true`；
- Dashboard 返回 HTTP 200；
- 浏览器已成功显示 ECHO 首页；
- 虚构账号的登录 POST 到达真实认证层并按预期返回 HTTP 401；
- 重启后的 Web 进程加载了新 `PUBLIC_APP_ORIGIN` 和 `turn:39.102.118.53:3478?transport=udp`。
- KV `origin_base_url` 已初始化并能正确读回当前 Quick Tunnel URL；
- Worker cron 日志显示 `origin_discovery_complete`、`changed: false`、执行结果 `ok`。

代理代码与操作说明位于 `ops/cloudflare-demo-proxy/`。

Quick Tunnel 地址变更已自动化，不再需要手工修改或重新部署 Worker：

1. 3090 的 `echo-demo-origin-sync.service` 从当前 `echo-demo-tunnel.service` 进程日志提取最新地址，并原子写入 `/home/user/echo/runtime/demo-proxy-origin.url`；
2. tunnel unit 的 `ExecStartPost` 会在每次启动后立即安排同步；`echo-demo-origin-sync.timer` 每 5 分钟补偿同步一次；
3. LiveTalking 稳定命名 Tunnel 的 `/health` 返回非敏感字段 `demoOrigin`；
4. Worker 的 `* * * * *` cron 每分钟从 `https://livetalking.echodigitalpersona.com/health` 拉取最新地址，仅在变化时写入 `ORIGIN_CONFIG` KV；
5. 代理请求从 KV 读取活动 origin，`ORIGIN_BASE_URL` 只作为 KV 尚未初始化时的回退。

该设计避免 3090 直接访问在其网络中被 DNS 污染和 TLS 阻断的 `workers.dev`。为早期 push 方案生成的 `ORIGIN_UPDATE_TOKEN` Worker secret 及 3090 临时令牌文件已经撤销/删除，不再存在额外长期凭据。

## 回滚步骤

如果新节点出现问题：

1. 在 3090 上把 `livetalking.env.backup-codex-20260830-pre-coturn-migration` 恢复为 `livetalking.env`；
2. 重启 `echo-livetalking.service` 和 `echo-demo-web.service`；
3. 确认网关 `/health`、Demo 页面以及一次 WebRTC 会话正常；
4. 保持旧节点 `47.116.3.151` 在线，直至问题排除。

恢复操作会覆盖活动配置，执行前应再次备份当时的 `livetalking.env`。

## 旧节点下线条件

若仍要保障原主域名，只有以下条件全部满足后，才可停止旧 1 核 1G ECS：

- 学生账号下 Worker 的 `TURN_SERVER_URL` 已改为新地址，或主域名已迁移到可管理的新 Worker；
- 从主域名登录后创建真实数字人会话，浏览器 ICE 状态保持 connected；
- 在受限网络下确认浏览器实际能使用 relay candidate，而不只是同机 host candidate；
- 新节点至少稳定观察 24 小时；
- 已保存最终 coturn 配置和回滚信息。

满足以上条件后，先停止旧实例观察，不要立即释放；再确认生产无回归，最后由负责人明确批准释放旧 ECS。

如果欠费导致旧实例必须立即停机，则将 workers.dev 替代入口作为唯一 Demo 地址，并明确告知使用者不要再从 `echodigitalpersona.com` 发起数字人会话。此时仍应先停止而非主动释放旧实例，以便欠费状态允许时保留最后的回滚机会。
