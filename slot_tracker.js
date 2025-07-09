// 持续跟踪门诊放号情况，在有号的情况下，发出通知

import fs from "fs/promises";
import { existsSync, watch } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenv.config();

// 所有用到的环境变量列在此处
const ENV_SENDCHAN_KEY = process.env.SENDCHAN_KEY;
const ENV_PUSHDEAR_KEYS = process.env.PUSHDEAR_KEYS;
const ENV_OPENID_LINKINGCLOUD = process.env.OpenID_LinkingCloud;
const ENV_NOTIFY_HAJI_ONLY = process.env.NOTIFY_HAJI_ONLY;

// 编码和名称的映射，可在运行时更新
const infoMap = {
    "1001_1_1207_633": "廖力维",
    "1001_1_1207_922": "金金",
    "1001_1_1207_1322": "李冠军",
    "1001_1_1207": "成人ADHD咨询",

    // 更新信息映射
    // data 结构见 sample_messages/OrderDeptResources.resp.json
    updateInfoMap(data) {
        data?.hospitalList?.forEach(o => {
            const code = o?.hospitalID;
            const name = o?.hospitalName;
            if (code && name) {
                console.log(`更新医院信息: ${code} - ${name}`);
                this[code] = name;
            }
        });
        data?.deptLevel1List?.forEach(o => {
            const code = o?.deptCode;
            const name = o?.deptName;
            if (code && name) {
                console.log(`更新一级科室信息: ${code} - ${name}`);
                this[code] = name;
            }
        });
        data?.deptLevel2List?.forEach(o => {
            const code = o?.deptCode;
            const name = o?.deptName;
            if (code && name) {
                console.log(`更新二级科室信息: ${code} - ${name}`);
                this[code] = name;
            }
        });
        data?.deptResourceDocList?.forEach(o => {
            const code = o?.docCode;
            const name = o?.docName;
            if (code && name) {
                console.log(`更新医生信息: ${code} - ${name}`);
                this[code] = name;
            }
        });
    },
};

// 添加错误记录文件路径
const ERROR_LOG_PATH = path.join(__dirname, "error.log.json");

// 全局cookie变量
let currentCookie = "";

// 监听.env文件变化并重新加载OpenID
function watchEnvFile() {
    const envPath = path.join(__dirname, ".env");
    console.log(`开始监听 ${envPath} 文件变化...`);

    watch(envPath, eventType => {
        if (eventType === "change") {
            console.log(".env文件已变更，重新加载环境变量...");
            // 重新加载环境变量
            dotenv.config();

            // 验证OpenID是否存在
            if (!ENV_OPENID_LINKINGCLOUD) {
                console.error("错误: OpenID_LinkingCloud未配置，请检查.env文件");
            } else {
                console.log("OpenID_LinkingCloud已更新，将在下次检查时重新获取cookie");
                // 清空当前cookie，强制重新登录
                currentCookie = "";
            }
        }
    });
}

async function sendNotification(title, content) {
    const SENDCHAN_KEY = ENV_SENDCHAN_KEY;
    if (SENDCHAN_KEY) {
        try {
            await sendNotificationByServerChan(SENDCHAN_KEY, title, content);
        } catch (error) {
            console.error("Server酱通知发送失败:", error);
        }
    }
    const PUSHDEAR_KEYS = ENV_PUSHDEAR_KEYS;
    if (PUSHDEAR_KEYS) {
        PUSHDEAR_KEYS.split(",").forEach(async key => {
            try {
                await sendNotificationByPushDear(key, title, content);
            } catch (error) {
                console.error("PushDear通知发送失败:", error);
            }
        });
    }
}

// 使用Server酱发送通知
async function sendNotificationByServerChan(token, title, desp) {
    const url = `https://sctapi.ftqq.com/${token}.send`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            title: title,
            desp: desp,
        }),
    });

    return response.status === 200;
}

// 使用PushDear发送通知
async function sendNotificationByPushDear(token, title, desp) {
    const url = `https://api2.pushdeer.com/message/push?pushkey=${token}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            text: title,
            desp: desp,
            type: "markdown",
        }),
    });

    return response.status === 200;
}

// 通过OpenID获取Cookie
async function getCookie() {
    // 如果当前已有Cookie，直接返回
    if (currentCookie) {
        return currentCookie;
    }

    // 检查OpenID是否存在
    if (!ENV_OPENID_LINKINGCLOUD) {
        throw new Error("环境变量OpenID_LinkingCloud未设置，无法进行登录认证");
    }

    console.log("正在通过OpenID获取新的Cookie...");

    try {
        const openIDCookie = `OpenID_LinkingCloud=${ENV_OPENID_LINKINGCLOUD}`;

        const response = await fetch(
            "https://fwcs.linkingcloud.cn/Account/Login?ReturnUrl=%2Fapp%2Funattended%2Findex.html",
            {
                method: "GET",
                headers: {
                    Cookie: openIDCookie,
                },
                redirect: "manual", // 不自动跟随重定向，以便获取响应头
            }
        );

        // 检查是否是302重定向
        if (response.status === 302) {
            // 从响应头中获取Set-Cookie
            const setCookieHeaders = response.headers.getSetCookie();
            if (!setCookieHeaders || setCookieHeaders.length === 0) {
                throw new Error("登录成功但未获取到Cookie");
            }

            // 从Set-Cookie中提取FuWuChuang的值
            for (const cookieStr of setCookieHeaders) {
                const match = cookieStr.match(/FuWuChuang=([^;]+)/);
                if (match && match[1]) {
                    currentCookie = `FuWuChuang=${match[1]}`;
                    console.log("成功获取到新的Cookie");
                    return currentCookie;
                }
            }

            throw new Error("未在响应头中找到FuWuChuang Cookie");
        } else {
            throw new Error(`登录失败，状态码: ${response.status}`);
        }
    } catch (error) {
        console.error("获取Cookie失败:", error);
        throw error;
    }
}

// 保存上次结果
async function saveLastResult(which, data) {
    const filepath = path.join(__dirname, which + ".last_result.json");
    try {
        await fs.writeFile(filepath, JSON.stringify(data));
    } catch (error) {
        console.error("保存上次结果失败:", error);
    }
}

// 读取上次结果
async function getLastResult(which) {
    const filepath = path.join(__dirname, which + ".last_result.json");
    try {
        if (existsSync(filepath)) {
            const data = await fs.readFile(filepath, "utf8");
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("读取上次结果失败:", error);
    }
    return null;
}

// 比较结果是否有变化
function hasResultChanged(oldData, newData) {
    if (!oldData) return true;

    // 比较可用预约情况
    const oldAvailable = oldData.deptResourceDocNoSourceList
        .filter(slot => slot.isAvailable === "1")
        .map(slot => `${slot.docCode}-${slot.day}-${slot.resourceMemo}`);

    const newAvailable = newData.deptResourceDocNoSourceList
        .filter(slot => slot.isAvailable === "1")
        .map(slot => `${slot.docCode}-${slot.day}-${slot.resourceMemo}`);

    // 如果可用预约的数量不同，说明有变化
    if (oldAvailable.length !== newAvailable.length) return true;

    // 排序后比较每一项
    oldAvailable.sort();
    newAvailable.sort();

    for (let i = 0; i < oldAvailable.length; i++) {
        if (oldAvailable[i] !== newAvailable[i]) return true;
    }

    return false;
}

// 读取错误日志
async function getErrorLog() {
    try {
        if (existsSync(ERROR_LOG_PATH)) {
            const data = await fs.readFile(ERROR_LOG_PATH, "utf8");
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("读取错误日志失败:", error);
    }
    return {};
}

// 保存错误日志
async function saveErrorLog(errorLog) {
    try {
        await fs.writeFile(ERROR_LOG_PATH, JSON.stringify(errorLog));
    } catch (error) {
        console.error("保存错误日志失败:", error);
    }
}

// 处理错误并发送通知(如果是新错误)
async function handleError(error, context) {
    const errorMessage = error.toString();
    const errorKey = `${context}:${errorMessage}`;

    // 获取错误日志
    const errorLog = await getErrorLog();
    const now = new Date().getTime();
    const hourInMs = 60 * 60 * 1000;

    // 检查是否需要发送通知(新错误或上次发送已过24小时)
    if (!errorLog[errorKey] || now - errorLog[errorKey] > 24 * hourInMs) {
        console.error(`[${new Date().toLocaleString()}] ${context}:`, error);

        // 发送错误通知
        await sendNotification(
            "脚本运行出错",
            `运行时间: ${new Date().toLocaleString()}\n错误类型: ${context}\n错误信息: ${errorMessage}`
        );

        // 更新错误日志
        errorLog[errorKey] = now;
        await saveErrorLog(errorLog);
    } else {
        // 只记录到控制台，不发送通知
        console.error(`[${new Date().toLocaleString()}] ${context} (已抑制通知):`, error);
    }
}

async function api(path, body) {
    // 获取Cookie
    const cookie = await getCookie();
    return fetch(`https://fwcs.linkingcloud.cn/${path}`, {
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
        },
        body: JSON.stringify(body),
        method: "POST",
    });
}

async function apiJsonCheckOk(response) {
    const code = response.status;
    // 处理401未授权错误，直接退出程序
    if (code === 401) {
        currentCookie = "";
        return null; // 下次重试
    }
    if (code !== 200) {
        await handleError(new Error(`请求失败，状态码: ${code}`), "HTTP请求错误");
        return null;
    }
    const data = await response.json();
    // 检查请求是否成功
    if (data.responseResult.isSuccess !== "1") {
        await handleError(new Error(`${data.responseResult.message}`), "API响应错误");
        return null;
    }
    return data;
}

// 拉取编码映射
async function fetchDeptResources() {
    try {
        // 获取上次结果
        let data = undefined;
        const lastResult = await getLastResult("OrderDeptResources");
        if (lastResult && lastResult.length > 0) {
            console.log(`[${new Date().toLocaleString()}] 使用上次的编码映射数据...`);
            data = lastResult;
        } else {
            console.log(`[${new Date().toLocaleString()}] 正在拉取编码映射...`);
            const response = await api("YuYue/OrderDeptResources", {});

            data = await apiJsonCheckOk(response);
            if (!data) {
                return;
            }
            await saveLastResult("OrderDeptResources", data);
        }
        // 更新信息映射
        if (data) {
            infoMap.updateInfoMap(data);
        }
    } catch (error) {
        await handleError(error, `拉取编码映射错误`);
        return;
    }
}

// 检查医生哪天有号
async function checkDoctorSlots(docCode) {
    const docName = infoMap[docCode] || docCode;

    // 检查医生特定日期的可用时段
    async function checkDoctorDaySlots(day) {
        console.log(`[${new Date().toLocaleString()}] 正在检查医生 ${docName} 在 ${day} 的空闲时段...`);
        try {
            const response = await api("YuYue/OrderDocNoSources", {
                docCode: docCode,
                day: day,
            });

            const data = await apiJsonCheckOk(response);
            if (!data) {
                return [];
            }

            // 所有可用时段
            let allAvailableSlots = [];
            for (const dayInfo of data.docResourceResourceList) {
                if (dayInfo.isAvailable !== "1") {
                    continue;
                }
                allAvailableSlots.push({
                    name: docName,
                    date: day,
                    memo: dayInfo.resourceMemo,
                    time: dayInfo.timeEnd,
                    haji: !dayInfo.timeEnd.includes("初诊:已满"), // 初诊有号
                });
            }
            return allAvailableSlots;
        } catch (error) {
            await handleError(error, `检查日期 ${day} 错误`);
            return [];
        }
    }

    try {
        console.log(`[${new Date().toLocaleString()}] 正在检查医生 ${docName} 的空闲日期...`);

        const response = await api("YuYue/OrderDocNoSources", {
            docCode: docCode,
        });

        const data = await apiJsonCheckOk(response);
        if (!data) {
            return;
        }

        // 找出医生可上班且有号的日期
        const availableDays = data.docResourceDayList.filter(day => day.isDay === "1" && day.isAvailable === "1");
        if (availableDays.length === 0) {
            console.log(`当前医生【${docName}】没有可预约的日期。`);
            return;
        }

        console.log(`找到 ${availableDays.length} 个可能有号的当值日期，正在查询具体时段...`);
        let allAvailableSlots = await Promise.all(availableDays.map(day => checkDoctorDaySlots(day.date)));
        allAvailableSlots = allAvailableSlots.flat();

        // 获取上次结果
        const lastResult = await getLastResult("OrderDocNoSources");
        // 比较结果是否有变化
        let changed = true;
        if (lastResult && lastResult.length > 0) {
            const thisSlotKeys = allAvailableSlots.map(slot => JSON.stringify(slot));
            const lastSlotKeys = lastResult.map(slot => JSON.stringify(slot));

            // 排序后比较每一项
            thisSlotKeys.sort();
            lastSlotKeys.sort();

            changed =
                thisSlotKeys.length !== lastSlotKeys.length ||
                thisSlotKeys.some((key, index) => key !== lastSlotKeys[index]);
        }

        // 只有在结果有变化时才发送通知
        if (!changed) {
            console.log("预约信息没有变化，跳过通知。");
            return;
        }

        // 保存本次结果
        await saveLastResult("OrderDocNoSources", allAvailableSlots);

        if (allAvailableSlots.length === 0) {
            console.log("当前没有可用的预约。");
            return;
        }
        // 按日期分组
        const slotsByDate = {};
        allAvailableSlots.forEach(slot => {
            if (!slotsByDate[slot.date]) {
                slotsByDate[slot.date] = [];
            }
            slotsByDate[slot.date].push(slot);
        });

        // 生成通知内容
        let notificationContent = `# ${docName}可预约时段\n\n`;
        for (const [date, slots] of Object.entries(slotsByDate)) {
            const weekday = new Date(date).toLocaleDateString("zh-CN", { weekday: "long" });
            notificationContent += `## ${date} (${weekday})\n\n`;

            slots.forEach(slot => {
                let line = `${slot.time} ${slot.memo}`;
                if (slot.haji) {
                    line = `**${line}**`; // 加粗
                }
                notificationContent += `- ${line}\n`;
            });
            notificationContent += "\n";
        }

        console.log(notificationContent);
        const haveHaji = allAvailableSlots.some(slot => slot.haji);
        const notifyHajiOnly = !!ENV_NOTIFY_HAJI_ONLY;
        console.log("检测到预约信息有变化，发送通知...");
        if (haveHaji) {
            await sendNotification(`${docName}初诊可预约`, notificationContent);
        } else if (!notifyHajiOnly) {
            await sendNotification(`${docName}可预约`, notificationContent);
        }
    } catch (error) {
        await handleError(error, `检查医生 ${docName} 错误`);
        return;
    }
}

// 检查科室可用的预约并通知
// 关注医生详情
async function checkDepartmentSlots(deptCode) {
    const deptName = infoMap[deptCode] || deptCode;

    console.log(`[${new Date().toLocaleString()}] 正在检查科室 ${deptName} 预约情况...`);
    try {
        const response = await api("YuYue/OrderDocResources", {
            deptCode: deptCode,
        });

        const data = await apiJsonCheckOk(response);
        if (!data) {
            return;
        }

        // 获取上次结果
        const lastResult = await getLastResult("OrderDocResources");

        // 检查结果是否有变化
        const changed = hasResultChanged(lastResult, data);

        // 保存本次结果
        await saveLastResult("OrderDocResources", data);

        // 只有在结果有变化时才发送通知
        if (!changed) {
            console.log("预约信息没有变化，跳过通知。");
            return;
        }

        // 筛选可用的预约
        const availableSlots = data.deptResourceDocNoSourceList.filter(slot => slot.isAvailable === "1");

        if (availableSlots.length > 0) {
            console.log("\n找到以下可用预约:");
            let notificationContent = `# ${deptName}可预约医生\n\n`;

            availableSlots.forEach(slot => {
                const doctorName = infoMap[slot.docCode] || slot.docCode;
                const message = `- 医生: ${doctorName}, 日期: ${slot.day}, 详情: ${slot.resourceMemo}`;
                notificationContent += message + "\n";
            });
            notificationContent += "\n";

            console.log(notificationContent);
            console.log("检测到预约信息有变化，发送通知...");
            await sendNotification("发现可预约的医生", notificationContent);
        } else {
            console.log("当前没有可用的预约。");
        }
    } catch (error) {
        await handleError(error, "预约检查错误");
    }
}

// 定时运行函数
function scheduleTask(taskFn) {
    // 立即执行一次
    taskFn();

    // 定时检查
    setInterval(() => {
        const now = new Date();
        // 每分钟的0秒执行
        if (now.getSeconds() === 0) {
            taskFn();
        }
    }, 1000); // 每秒检查一次时间
}

async function help() {
    console.log(`mentalhealth600 使用方法:

# 按科室关注，在科室有空闲时发送提醒
node ./slot_tracker.js [科室代码]
# 按医生关注，在此科室的特定专家空闲时发送提醒
node ./slot_tracker.js [医生代码]

科室代码如 1001_1_1207 医生代码如 1001_1_1207_1322，认证授权方式见 README.md
`);
}

// 主函数
async function main() {
    try {
        // 检查环境变量
        if (!ENV_OPENID_LINKINGCLOUD) {
            throw new Error("环境变量OpenID_LinkingCloud未设置，请检查.env文件");
        }

        console.log("OpenID_LinkingCloud已配置，开始获取Cookie...");

        // 初始获取Cookie
        await getCookie();
        console.log("成功获取Cookie，开始定时检查...");

        // 启动.env文件监听
        watchEnvFile();

        await fetchDeptResources();

        // 解析命令行参数
        const inputCode = process.argv?.[2];
        switch ((inputCode && inputCode?.split("_").length) || 0) {
            case 3: {
                const searchDeptCode = inputCode;
                console.log(`关注科室编码: ${searchDeptCode}`);
                scheduleTask(() => checkDepartmentSlots(searchDeptCode));
                break;
            }
            case 4: {
                const searchDocCode = inputCode;
                console.log(`关注医生编码: ${searchDocCode}`);
                scheduleTask(() => checkDoctorSlots(searchDocCode));
                break;
            }
            default: {
                help();
                process.exit();
            }
        }
        console.log("脚本正在运行中，每分钟检查一次...");
    } catch (error) {
        await handleError(error, "程序初始化错误");
        process.exit(1); // 初始化失败时退出程序
    }
}

// 运行脚本
main();
