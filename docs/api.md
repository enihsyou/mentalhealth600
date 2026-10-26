# 平台接口与响应解密

[返回 README](../README.md)

医院请求只发送 `Authorization: Bearer JWT` 与 `Content-Type: application/json` 两个业务请求头。以下参数来自本地抓包，未向医院接口发起实测请求：

- `/api/YuYue/GetAllDeptList`：`source="deptList"`、`hospitalId=""`、`extInfo={"other":[{"groupID":"00","value":[]}]}`（JSON 字符串）。递归读取 `deptList` 中 `isDept=1` 的科室，并使用 `hospitalList` 标注院区。
- `/api/YuYue/GetDocList`：`dataSource="指定医生"`、`hospitalId=""`、`keyWord=""`、`pageSize=20`、`pageNo=1`；`extInfo` 为 `[{"groupID":"DateRange","value":["default"]},{"groupID":"00","value":[]}]` 的 JSON 字符串。当前抓包一次返回 444 项、没有分页总数字段，脚本按该响应完整读取，不逐科室扫描；未来服务端若改为分页，需要相应调整。医生 ID 的末段之前部分关联目录科室；无法关联时显示医生目录原有科室说明和名称中的院区，不猜测院区。
- `/api/YuYue/GetDeptResource`：`hospitalId`、`dataSource="科室号源"`、`deptCode`、`cycleConfigId=""`；读取 `docList[].docNoSource[]`。
- `/api/YuYue/GetDocResource`：`hospitalId`、`dataSource="医生号源"`、`docCode`、`latLongitude=""`、`extInfo="[]"`、`date=""`；一次读取全部 `noSource[].docResource[]`，医生姓名取 `docInfo.docName`。

315/316 响应在本地按 UTF-8 密钥、AES-ECB、PKCS7 解密。316 密钥为 `d + reverse(t.slice(8))`；315 从 `$LC$` 分段中提取密钥。`sample_response` 仅包含裁剪、脱敏后的结构示例，不含凭据或患者信息。
