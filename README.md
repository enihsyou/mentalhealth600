# mentalhealth600

上海市精神卫生中心门诊号源监听。Node.js 20.6+、pnpm，业务代码位于 `slot_tracker.js`。

因平台变更，当前版本无法实现自动登录，仅支持半自动方式：用户在微信登录并手工获取 JWT，脚本负责后续号源查询与通知；JWT 失效后由用户重新获取并更新 `.env`。

## 配置与使用

```powershell
pnpm install
Copy-Item .env.example .env
# 编辑 .env，填写 JWT 和 PushDeer key
pnpm start                       # 帮助与环境变量检查
pnpm start doctor                # 医生目录
pnpm start department            # 科室目录
pnpm start department 1_1_1076
pnpm start doctor 范毅敏
pnpm start department 综合心理
```

`node slot_tracker.js`（或 `pnpm start`）显示 CLI 帮助、JWT 本地到期/格式检查、通知环境变量状态和 JWT 设置指引，不请求医院接口、不发送通知，也不显示凭据内容。

`node slot_tracker.js doctor` 列出医生目录；`node slot_tracker.js department` 列出科室目录，包含 ID、中文名、所属科室及院区，随后退出。要监听时在子命令后加 ID 或中文名。中文名精确匹配；医生名可省略末尾括号中的院区。名称重复时列出候选 ID 与所属信息并退出，请改用 ID，不会自动选择。ID 应从当前目录取得，勿照抄示例。

停止监听后执行 `pnpm clean`，清理脚本目录的 `*.last_result.json`、`error.log.json` 及它们的 `.tmp` 文件。保留 `.env`、依赖、锁文件和响应示例。清理快照后再次启动，现有可约号源会作为新结果提醒。

脚本目录的 `.env`：

```dotenv
JWT="手工获取的完整JWT"
PUSHDEAR_KEYS="你的pushkey"
NOTIFY_HAJI_ONLY=0
```

只通过 `JWT` 提供医院凭据；可在启动环境中设置，也可在 `.env` 中设置，文件值优先。多个 PushDeer key 用逗号分隔。`NOTIFY_HAJI_ONLY=1` 只在医生模式比较、提醒包含“初诊:有号”的时段；科室摘要没有初诊细分，科室模式仍提醒全部可约号源。

## 微信登录与手工获取 JWT

1. 微信搜索“上海市精神卫生中心”，进入“预约挂号”，完成登录授权。
2. 通过本机 TLS 抓包工具查看 `fwcs.linkingcloud.cn` 的 `GetDocResource` 或 `GetDeptResource` 请求。
3. 从请求头 `Authorization: Bearer ...` 取出 Bearer 后面的完整 JWT，填写 `.env` 的 `JWT`，不要分享抓包或凭据。

JWT 失效后需要自行重新登录并更新 `.env`，脚本会自动恢复查询。详细行为见[认证状态、轮询与通知](docs/runtime.md)。

如需清理微信内置浏览器 Local Storage，可关闭微信后删除其数据目录下的 `xwechat/radium/web` 目录。具体位置取决于本机微信数据目录设置，请自行确认；脚本不会执行删除。

## 更多文档

- [平台接口与响应解密](docs/api.md)
- [认证状态、轮询与通知](docs/runtime.md)
- [变更记录](change%20log.md)

`.env`、快照、错误日志为本地运行状态，不应提交。不要分享 JWT、pushkey 或含患者信息的抓包。
