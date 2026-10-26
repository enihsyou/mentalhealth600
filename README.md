# mentalhealth600

上海市精神卫生中心门诊号源监听。Node.js 20.6+、pnpm，业务代码位于 `slot_tracker.js`。

## 配置与使用

```powershell
pnpm install
Copy-Item .env.example .env
# 编辑 .env，填写 JWT 和 PushDeer key
pnpm start
pnpm start 1_1_1076
pnpm start doctor 范毅敏
pnpm start department 综合心理
```

无参数时读取目录，输出全部可选科室和医生的 ID、中文名、所属科室与院区后退出。可直接传一个 ID 或中文名，也可用 `doctor` / `department` 限定类型。中文名精确匹配；医生名可省略末尾括号中的院区。名称重复时列出候选 ID 与所属信息并退出，请改用 ID，不会自动选择。ID 应从当前目录取得，勿照抄示例。

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

JWT 本地到期、格式无效或接口返回 HTTP 401 时，脚本暂停医院查询，并尝试发送一次标题为“JWT 失效｜号源监听已暂停”的通知。通知失败只在控制台提示，不退出、不循环重发。请自行重新登录并更新 `.env`；JWT 内容变化后自动恢复，同一内容反复保存、清空后重新填回已失效 token 都不会恢复或重复通知。此标记仅存在当前进程，重启后可再次通知。

每秒检查 `.env` 文件变化，支持编辑器原子替换文件；直接解析文件内容，不依赖 dotenv 默认不覆盖进程环境变量的行为。文件变量删除后回到启动环境对应值。文件短暂不存在时保留当前配置；没有 JWT 时继续等待。更换 token 不取消 WAF 等待。请求期间更新 JWT，旧请求结果会被丢弃，不会错误暂停新 JWT。

如需清理微信内置浏览器 Local Storage，可关闭微信后删除其数据目录下的 `xwechat/radium/web` 目录。具体位置取决于本机微信数据目录设置，请自行确认；脚本不会执行删除。

## 接口与抓包依据

医院请求只发送 `Authorization: Bearer JWT` 与 `Content-Type: application/json` 两个业务请求头。以下参数来自本地抓包，未向医院接口发起实测请求：

- `/api/YuYue/GetAllDeptList`：`source="deptList"`、`hospitalId=""`、`extInfo={"other":[{"groupID":"00","value":[]}]}`（JSON 字符串）。递归读取 `deptList` 中 `isDept=1` 的科室，并使用 `hospitalList` 标注院区。
- `/api/YuYue/GetDocList`：`dataSource="指定医生"`、`hospitalId=""`、`keyWord=""`、`pageSize=20`、`pageNo=1`；`extInfo` 为 `[{"groupID":"DateRange","value":["default"]},{"groupID":"00","value":[]}]` 的 JSON 字符串。当前抓包一次返回 444 项、没有分页总数字段，脚本按该响应完整读取，不逐科室扫描；未来服务端若改为分页，需要相应调整。医生 ID 的末段之前部分关联目录科室；无法关联时显示医生目录原有科室说明和名称中的院区，不猜测院区。
- `/api/YuYue/GetDeptResource`：`hospitalId`、`dataSource="科室号源"`、`deptCode`、`cycleConfigId=""`；读取 `docList[].docNoSource[]`。
- `/api/YuYue/GetDocResource`：`hospitalId`、`dataSource="医生号源"`、`docCode`、`latLongitude=""`、`extInfo="[]"`、`date=""`；一次读取全部 `noSource[].docResource[]`，医生姓名取 `docInfo.docName`。

315/316 响应在本地按 UTF-8 密钥、AES-ECB、PKCS7 解密。316 密钥为 `d + reverse(t.slice(8))`；315 从 `$LC$` 分段中提取密钥。`sample_response` 仅包含裁剪、脱敏后的结构示例，不含凭据或患者信息。

## 轮询与通知状态

首轮立即执行，整轮完成后等下个整分钟；请求串行、轮次不重叠、不补跑错过的轮次。任何请求失败都放弃本轮、保留旧快照，不把失败当成无号。HTTP 403、405、429 至少暂停 30 分钟，更长的 `Retry-After` 会延长等待；等待只在当前进程内保存。

快照按类型、目标 ID、院区和有效筛选条件隔离。无号时保存空快照，因此相同号源消失后恢复会再次提醒；有号时全部 key 和通知函数成功后才推进快照，失败则下一轮重新查询比较。只运行一个进程监听同一目标。部分 key 已成功或通知成功后进程退出，后续重试可能重复，不保证跨重启恰好一次。

Markdown 通知按日期分组，标题含医生、日期范围、号源条数，初诊可约时段加粗；条数不是可预约名额总数。同类普通错误通知成功后 24 小时内抑制；失败保留到下一轮重试。扩展通知服务仅需在 `notifiers` 中添加异步函数，失败必须抛出。

`.env`、快照、错误日志为本地运行状态，不应提交。不要分享 JWT、pushkey 或含患者信息的抓包。
