# 变更记录

## 基础版本（origin/main）

- 使用 `OpenID_LinkingCloud` 获取 Cookie，调用旧版 `OrderDeptResources`、`OrderDocNoSources`、`OrderDocResources` 接口查询科室、医生及可约日期、时段。
- 提供医生号源定时监听和科室号源查询逻辑，支持初诊筛选；将查询结果保存为本地快照，变化时发送通知。
- 集成 PushDeer 和 Server 酱通知，提供环境文件监听及错误通知记录。

## JWT 认证与平台接口迁移（当前版本）

- 因平台变更，改为半自动登录：用户通过微信登录、手工获取 JWT 并配置 `JWT`。移除自动登录、自动获取或刷新凭据及会话缓存逻辑。
- 使用 Bearer JWT 调用新版 `GetDeptResource` / `GetDocResource`，解密平台加密响应；通过 `GetAllDeptList` / `GetDocList` 读取目录，不逐科室扫描。
- JWT 失效时暂停医院查询，仅尝试一次失效通知；继续监听 `.env`，换成新 JWT 后恢复，旧请求不会暂停新凭据。
- CLI 根命令显示帮助、环境变量状态和 JWT 设置指引；`doctor` / `department` 无目标时列出对应目录，支持 ID、中文名及重名消歧。
- 保留 PushDeer 和简洁通知扩展入口；完善目标快照、空快照恢复提醒、通知成功后推进状态、串行轮询及 WAF 降频。通知正文按日期展示，控制台同时显示标题。
- 新增 `pnpm clean` 清理生成的快照、错误日志和临时文件；接口与运行机制说明移入 `docs`。
