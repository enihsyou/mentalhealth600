# mentalhealth600

在宛平南路600号拯救心理健康

## 介绍

本仓库提供一个 NodeJS 脚本用于自动化地跟踪**上海市精神卫生中心**放号并通知人类。

也就是 <https://fwcs.linkingcloud.cn/app/unattended/index.html#/outpatientService/yuyue/register?deptCode=1001_1_1207> 这个页面

## 配置

在运行脚本之前，请确保已配置以下环境变量：

- `OpenID_LinkingCloud`: 通过微信搜索上海市精神卫生中心，点击预约挂号，登陆后进浏览器`开发者工具 > 应用程序`提取 Cookie 中的同名条目
- `PUSHDEAR_KEYS`: 开源易用免安装的推送方案 [PushDear](https://www.pushdeer.com/)
- `SENDCHAN_KEY`: [Server酱](https://sct.ftqq.com/) 推送方案，作为备用

```ini
# Server酱 SendKey
SENDCHAN_KEY=SCT274

# PushPlus SendKey, 多个用逗号分隔
PUSHDEAR_KEYS=PDU344,PDU345

# 微信认证结果，用于重新登录获取Cookie
OpenID_LinkingCloud=04890EBF
```

> 打开开发者工具就被卡在断点上了，怎么办？
> 按 `Ctrl+F8` 关闭所有断点。ref: [bypass-disable-devtool.md](https://gist.github.com/aravindanve/3e13d995fac35e4a07c236b11cc432c7)

## 运行

```shell
# 按科室关注，在科室有空闲时发送提醒
node ./slot_tracker.js 1001_1_1207 
# 按专家关注，在此科室的特定专家空闲时发送提醒
node ./slot_tracker.js 1001_1_1207_1322
```

运行需要一个位置参数，表示关注的医生ID。通过访问科室列表，跟踪 `YuYue/OrderDeptResources` 接口的响应可以找到需要的值。

> 当前代码中着重关注**成人ADHD咨询**科室的放号情况，但脚本支持任意医生ID。

上海市精神卫生中心的心理咨询门诊（上海市心理咨询与治疗中心）每日 20:00 放号，可预约 30 天以内的门诊。
建议定时运行以减轻服务器压力。

### 其他

当前调用的 `checkDoctorSlots` 函数只关注单名医生的空闲情况，适用于找专家。
如果想要关注整个科室的空闲情况，可以自行修改为调用 `checkAvailableSlots` 函数。

## 示例输出

```log
OpenID_LinkingCloud已配置，开始获取Cookie...
正在通过OpenID获取新的Cookie...
成功获取到新的Cookie
成功获取Cookie，开始定时检查...
开始监听 /volume1/GitHub/mentalhealth600/.env 文件变化...
[5/11/2025, 7:59:00 PM] 正在检查医生 李冠军 的空闲日期...
当前医生 李冠军 没有可预约的日期。
[5/11/2025, 8:00:00 PM] 正在检查医生 李冠军 的空闲日期...
找到 1 个可能有号的当值日期，正在查询具体时段...
[5/11/2025, 8:00:01 PM] 正在检查医生 李冠军 在 2025-06-11 的空闲时段...
# 李冠军可预约时段

## 2025-06-11 (Wednesday)

- 08:00-08:30【初诊:已满 复诊:有号】 余号 2
- **08:30-09:00【初诊:有号 复诊:有号】 余号 3**
- **09:00-09:30【初诊:有号 复诊:有号】 余号 3**
- 09:30-10:00【初诊:已满 复诊:有号】 余号 1
- 10:00-10:30【初诊:已满 复诊:有号】 余号 2

检测到预约信息有变化，发送通知...
```
