// 上海市精神卫生中心号源监听；业务流程保持单文件、串行执行。
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = "https://fwcs.linkingcloud.cn";
const ENV_FILE = path.join(DIR, ".env");
const ERROR_FILE = path.join(DIR, "error.log.json");
const DAY = 24 * 60 * 60 * 1000;
const startupEnv = { ...process.env };
const yes = value => String(value) === "1";
const interrupted = new Error("认证配置已变化，本轮结果丢弃");
let config = { ...startupEnv };
let auth = { token: (startupEnv.JWT || "").replace(/^Bearer\s+/i, "").trim(), blocked: false };
let configRead = Promise.resolve();
let pausedUntil = 0;
let catalog;
const blockedTokens = new Set();
const env = name => (config[name] || "").trim();

async function readJson(file) {
    return existsSync(file) ? JSON.parse(await fs.readFile(file, "utf8")) : null;
}

async function writeJson(file, value) {
    // 临时文件替换，避免中途退出留下半个快照。
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
}

function loadConfig(announce = true) {
    configRead = configRead.catch(() => {}).then(async () => {
        let parsed;
        try {
            parsed = dotenv.parse(await fs.readFile(ENV_FILE));
        } catch (error) {
            // 原子替换时文件可短暂不存在；保留当前配置，等待下一次读取。
            if (error.code === "ENOENT") return;
            throw error;
        }
        config = { ...startupEnv, ...parsed };
        const token = env("JWT").replace(/^Bearer\s+/i, "").trim();
        if (token === auth.token) return;
        auth = { token, blocked: blockedTokens.has(token) };
        catalog = undefined;
        if (announce) {
            console.log(!token ? "JWT 未配置，等待更新 .env"
                : auth.blocked ? "该 JWT 已失效，继续等待新 JWT" : "JWT 已更新，恢复查询");
        }
    });
    return configRead;
}

async function pauseAuth(requestAuth) {
    if (requestAuth !== auth || requestAuth.blocked) return;
    // 先标记，再尝试一次通知；失败也不重复发送，监听仍继续。
    requestAuth.blocked = true;
    blockedTokens.add(requestAuth.token);
    console.error("JWT 已失效，医院查询已暂停；请重新登录并更新 .env 的 JWT");
    try {
        await sendNotification("JWT 失效｜号源监听已暂停", "请在微信重新登录，手工获取 JWT 并更新脚本目录 .env 的 JWT。保存后自动恢复查询。");
    } catch {
        console.error("JWT 失效通知未送达；继续等待 .env 的 JWT 更新");
    }
}

function tokenExpired(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        return !payload.exp || payload.exp * 1000 <= Date.now();
    } catch {
        return true;
    }
}

function decryptResponse(payload) {
    const data = { ...payload };
    const code = String(data.code);
    if (code !== "315" && code !== "316") return data;
    if (code === "315" && !data.aesKey && data.bizContent) {
        const parts = data.bizContent.split("$LC$");
        if (parts.length === 3) {
            data.aesKey = parts[2];
            parts[2] = "";
            data.bizContent = parts.join("$LC$");
        }
    }
    if (code === "316") {
        data.aesKey = data.d + data.t.slice(8).split("").reverse().join("");
    }
    let text = data.bizContent || "";
    if (data.aesKey && text.includes("$LC$")) {
        const key = Buffer.from(data.aesKey, "utf8");
        const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
        text = Buffer.concat([
            decipher.update(Buffer.from(text.slice(4, -4), "base64")),
            decipher.final(),
        ]).toString("utf8");
    }
    return { ...data, ...JSON.parse(text) };
}

async function api(endpoint, body, requestAuth) {
    await loadConfig();
    if (requestAuth !== auth || auth.blocked || !auth.token) throw interrupted;
    if (tokenExpired(requestAuth.token)) {
        await pauseAuth(requestAuth);
        throw interrupted;
    }
    const response = await fetch(`${HOST}/api/YuYue/${endpoint}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requestAuth.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    await loadConfig();
    if ([403, 405, 429].includes(response.status)) {
        const retryAfter = response.headers.get("retry-after");
        const retryMs = /^\d+$/.test(retryAfter || "")
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        pausedUntil = Date.now() + Math.max(30 * 60_000, retryMs || 0);
        throw new Error(`HTTP ${response.status}：停止本轮，至少延后 30 分钟`);
    }
    // 请求期间换了 JWT，旧响应不能暂停新凭据或推进新一轮的快照。
    if (requestAuth !== auth) throw interrupted;
    if (response.status === 401) {
        await pauseAuth(requestAuth);
        throw interrupted;
    }
    if (!response.ok) throw new Error(`医院接口 HTTP ${response.status}`);
    const data = decryptResponse(await response.json());
    if (requestAuth !== auth) throw interrupted;
    if (!yes(data.responseResult?.isSuccess)) throw new Error("医院接口返回业务失败");
    return data;
}

async function fetchCatalog(requestAuth) {
    const departments = await api("GetAllDeptList", {
        source: "deptList", hospitalId: "",
        extInfo: JSON.stringify({ other: [{ groupID: "00", value: [] }] }),
    }, requestAuth);
    const doctors = await api("GetDocList", {
        dataSource: "指定医生", hospitalId: "", keyWord: "", pageSize: 20, pageNo: 1,
        extInfo: JSON.stringify([
            { groupID: "DateRange", value: ["default"] },
            { groupID: "00", value: [] },
        ]),
    }, requestAuth);
    // 当前目录抓包 pageSize=20 仍返回完整 444 项，无分页总数字段。
    const hospitals = new Map(departments.hospitalList.map(item => [item.hospitalID, item.hospitalName]));
    const entries = [];
    function addDepartments(items, parent = "") {
        for (const item of items) {
            if (yes(item.isDept)) {
                entries.push({
                    mode: "department", id: item.deptCode, name: item.deptName,
                    department: parent, hospitalId: item.hospitalID,
                    hospital: hospitals.get(item.hospitalID),
                });
            }
            addDepartments(item.deptList || [], item.deptName);
        }
    }
    addDepartments(departments.deptList);
    const deptById = new Map(entries.map(item => [item.id, item]));
    for (const doctor of doctors.docList) {
        const deptId = doctor.docCode.slice(0, doctor.docCode.lastIndexOf("_"));
        const department = deptById.get(deptId);
        entries.push({
            mode: "doctor", id: doctor.docCode, name: doctor.docName,
            department: department?.name || doctor.memo,
            hospitalId: department?.hospitalId || "",
            hospital: department?.hospital || "院区见医生名称",
        });
    }
    return entries;
}

function describeTarget(target) {
    return `${target.mode === "doctor" ? "医生" : "科室"} ${target.id}  ${target.name}｜${target.department}｜${target.hospital}（院区 ID ${target.hospitalId || "未提供"}）`;
}

function resolveTarget(input, mode) {
    const candidates = catalog.filter(item => (!mode || item.mode === mode) &&
        (item.id === input || item.name === input ||
            (item.mode === "doctor" && item.name.replace(/[（(][^（）()]*[）)]$/, "") === input)));
    if (candidates.length === 1) return candidates[0];
    console.error(candidates.length ? "名称有重复，请改用候选 ID：" : "未找到目标，请运行 doctor 或 department 查看对应目录。");
    for (const candidate of candidates) console.error(describeTarget(candidate));
    return null;
}

async function fetchDoctorSlots(target, requestAuth) {
    const data = await api("GetDocResource", {
        hospitalId: target.hospitalId, dataSource: "医生号源", docCode: target.id,
        latLongitude: "", extInfo: "[]", date: "",
    }, requestAuth);
    const slots = [];
    for (const group of data.noSource) {
        for (const item of group.docResource) {
            if (!yes(item.isAvailable)) continue;
            slots.push({
                resourceID: item.resourceID, docCode: item.docCode,
                doctor: data.docInfo.docName, department: item.deptName,
                deptCode: item.deptCode, hospitalId: item.hospitalID,
                hospital: item.hospitalName, date: item.day,
                time: item.timeEnd, memo: item.resourceMemo,
                haji: /初诊[:：]\s*有号/.test(item.timeEnd),
            });
        }
    }
    return slots;
}

async function fetchDepartmentSlots(target, requestAuth) {
    const data = await api("GetDeptResource", {
        hospitalId: target.hospitalId, dataSource: "科室号源",
        deptCode: target.id, cycleConfigId: "",
    }, requestAuth);
    const slots = [];
    for (const doctor of data.docList) {
        for (const item of doctor.docNoSource) {
            if (!yes(item.isAvailable)) continue;
            slots.push({
                docCode: item.docCode, doctor: doctor.docName, department: item.deptName,
                deptCode: item.deptCode, hospitalId: item.hospitalID,
                hospital: target.hospital, date: item.day, time: "", memo: item.resourceMemo,
            });
        }
    }
    return slots;
}

async function pushDeer(title, content) {
    const keys = [...new Set(env("PUSHDEAR_KEYS").split(",").map(key => key.trim()).filter(Boolean))];
    if (!keys.length) throw new Error("未配置 PUSHDEAR_KEYS");
    for (const key of keys) {
        const response = await fetch("https://api2.pushdeer.com/message/push", {
            method: "POST",
            body: new URLSearchParams({ pushkey: key, text: title, desp: content, type: "markdown" }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`PushDeer HTTP ${response.status}`);
        const data = await response.json();
        if (Number(data.code) !== 0 || !data.content?.result?.length ||
            !data.content.result.every(result => JSON.parse(result).success === "ok")) {
            throw new Error("PushDeer 未确认推送成功");
        }
    }
}

// 新接入通知服务只需添加一个 async (title, content) 函数；失败必须抛出。
const notifiers = [pushDeer];
async function sendNotification(title, content) {
    for (const notify of notifiers) await notify(title, content);
}

function buildMessage(target, slots) {
    const doctors = [...new Set(slots.map(slot => slot.doctor))];
    const days = [...new Set(slots.map(slot => slot.date))].sort();
    const dateLabel = days.length === 1 ? days[0] : `${days[0]}起${days.length}天`;
    const doctorLabel = doctors.slice(0, 3).join("、") + (doctors.length > 3 ? `等${doctors.length}位` : "");
    const title = [target.name, doctorLabel, slots.some(slot => slot.haji) ? "初诊可约" : "可预约",
        dateLabel, `${slots.length}条号源`].join("｜");
    const lines = [];
    for (const day of days) {
        lines.push(`## ${day}`, "");
        for (const slot of slots.filter(slot => slot.date === day)) {
            const text = [slot.doctor, slot.department, slot.hospital, slot.time, slot.memo].filter(Boolean).join(" · ");
            lines.push(`- ${slot.haji ? `**${text}**` : text}`);
        }
        lines.push("");
    }
    return { title, content: lines.join("\n") };
}

async function checkSlots(target, requestAuth) {
    const doctor = target.mode === "doctor";
    const hajiOnly = doctor && yes(env("NOTIFY_HAJI_ONLY"));
    let slots = doctor ? await fetchDoctorSlots(target, requestAuth) : await fetchDepartmentSlots(target, requestAuth);
    if (hajiOnly) slots = slots.filter(slot => slot.haji);
    slots.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const snapshotKey = crypto.createHash("sha256")
        .update(JSON.stringify([target.mode, target.id, target.hospitalId, hajiOnly])).digest("hex");
    const file = path.join(DIR, `${snapshotKey}.last_result.json`);
    if (requestAuth !== auth) throw interrupted;
    if (JSON.stringify(await readJson(file)) === JSON.stringify(slots)) return;
    if (slots.length) {
        const { title, content } = buildMessage(target, slots);
        console.log(`${title}\n\n${content}`);
        await sendNotification(title, content);
    }
    if (requestAuth !== auth) throw interrupted;
    // 无号也推进空快照；有号必须等全部通知成功，失败保留旧快照。
    await writeJson(file, slots);
}

async function handleError(error, target) {
    // 不记录 fetch 的 URL/cause 或服务端正文，避免凭据和患者信息进入日志/推送。
    const message = error instanceof TypeError || error instanceof SyntaxError || error.name === "TimeoutError"
        ? "请求或响应处理失败" : error.message;
    console.error(`[${new Date().toLocaleString()}] ${target}: ${message}`);
    const log = await readJson(ERROR_FILE) || {};
    const key = `${target}:${message}`;
    if (Date.now() - (log[key] || 0) < DAY) return;
    try {
        await sendNotification(`监听出错｜${target}`, `${message}\n\n时间：${new Date().toLocaleString()}`);
        log[key] = Date.now();
        await writeJson(ERROR_FILE, log);
    } catch {
        console.error("错误通知未送达，后续轮次将重试");
    }
}

function printHelp() {
    console.log(`用法：
  node slot_tracker.js                         显示帮助和环境变量状态
  node slot_tracker.js doctor                  列出医生 ID、姓名、所属科室和院区
  node slot_tracker.js doctor <ID或中文名>     监听医生号源
  node slot_tracker.js department              列出科室 ID、名称和院区
  node slot_tracker.js department <ID或中文名> 监听科室号源
  pnpm clean                                  清理生成的快照、错误日志和临时文件

环境变量（脚本目录 .env 优先于启动环境）：
  JWT：${!auth.token ? "未设置" : tokenExpired(auth.token) ? "已设置，但已过期或格式无效" : "已设置，本地到期检查通过"}
  PUSHDEAR_KEYS：${env("PUSHDEAR_KEYS") ? "已设置" : "未设置，监听通知需要此项"}
  NOTIFY_HAJI_ONLY：${yes(env("NOTIFY_HAJI_ONLY")) ? "开启，仅医生模式筛选初诊" : "关闭"}

设置 JWT：
  1. 复制 .env.example 为脚本目录的 .env。
  2. 微信进入“上海市精神卫生中心”→“预约挂号”，完成登录。
  3. 本机 TLS 抓包查看 GetDocResource / GetDeptResource 请求头，
     将 Authorization 中 Bearer 后面的完整字符串填入 .env 的 JWT。
  4. 填写 PUSHDEAR_KEYS 后运行监听；JWT 失效后重新获取并更新 .env。
本地检查不验证服务端是否接受 JWT，帮助命令不会发送请求。`);
}

async function cleanGeneratedFiles() {
    const files = await fs.readdir(DIR);
    for (const file of files) {
        if (!file.endsWith(".last_result.json") && !file.endsWith(".last_result.json.tmp") &&
            file !== "error.log.json" && file !== "error.log.json.tmp") continue;
        await fs.unlink(path.join(DIR, file));
        console.log(`已清理 ${file}`);
    }
}

async function main() {
    const [mode, input, ...extra] = process.argv.slice(2);
    if (mode === "clean" && !input) {
        await cleanGeneratedFiles();
        return;
    }
    await loadConfig(false);
    if (!["doctor", "department"].includes(mode) || extra.length) {
        printHelp();
        return;
    }
    watchFile(ENV_FILE, { interval: 1000 }, () => {
        loadConfig().catch(() => console.error(".env 读取失败"));
    });
    let nextRound = 0;
    let previousAuth;
    try {
        for (;;) {
            await loadConfig();
            if (auth !== previousAuth) {
                previousAuth = auth;
                nextRound = 0;
            }
            if (auth.token && !auth.blocked && Date.now() >= Math.max(nextRound, pausedUntil)) {
                const requestAuth = auth;
                try {
                    if (!catalog) catalog = await fetchCatalog(requestAuth);
                    if (!input) {
                        for (const target of catalog.filter(item => item.mode === mode)) {
                            console.log(describeTarget(target));
                        }
                        return;
                    }
                    const target = resolveTarget(input, mode);
                    if (!target) return;
                    await checkSlots(target, requestAuth);
                } catch (error) {
                    if (error !== interrupted && requestAuth === auth) {
                        await handleError(error, input || "目录");
                    }
                }
                // 串行等待整轮结束；错过的整分钟不补跑。
                nextRound = Date.now() + 60_000 - Date.now() % 60_000;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        unwatchFile(ENV_FILE);
    }
}

main().catch(() => {
    console.error("本地配置或状态文件读写失败，监听已停止");
    process.exitCode = 1;
});
