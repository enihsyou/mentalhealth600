// 上海市精神卫生中心号源监听；业务流程保持单文件、串行执行。
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = "https://fwcs.linkingcloud.cn";
const SESSION_FILE = path.join(DIR, ".session.json");
const ERROR_FILE = path.join(DIR, "error.log.json");
const DAY = 24 * 60 * 60 * 1000;
const env = name => (process.env[name] || "").trim();
const nameMap = new Map();
const nameOf = code => nameMap.get(String(code)) || code;
const yes = value => String(value) === "1";
let envKeys = [];
let session;
let source = "";
let pausedUntil = 0;
let namesLoaded = false;

async function readJson(file) {
    return existsSync(file) ? JSON.parse(await fs.readFile(file, "utf8")) : null;
}

async function writeJson(file, value) {
    // 临时文件替换，避免中途退出留下半个 JSON；凭据文件不应进入版本库。
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
}

async function loadEnv() {
    const file = path.join(DIR, ".env");
    const parsed = existsSync(file) ? dotenv.parse(await fs.readFile(file)) : {};
    for (const key of envKeys) {
        if (!(key in parsed)) delete process.env[key];
    }
    dotenv.populate(process.env, parsed, { override: true });
    envKeys = Object.keys(parsed);
}


function authParams() {
    let url;
    try {
        url = new URL(env("LINKINGCLOUD_AUTH_URL"));
    } catch {
        throw new Error("LINKINGCLOUD_AUTH_URL 必须是完整的 AuthLogin URL");
    }
    const authCode = url.searchParams.get("auth_code");
    const state = url.searchParams.get("state");
    if (url.origin !== HOST || !/^\/{1,2}Account\/AuthLogin$/.test(url.pathname) || !authCode || !state) {
        throw new Error("LINKINGCLOUD_AUTH_URL 的站点、路径或 auth_code/state 参数不正确");
    }
    return new URLSearchParams({ auth_code: authCode, state });
}

async function refreshConfig() {
    await loadEnv();
    const next = crypto.createHash("sha256").update(env("LINKINGCLOUD_AUTH_URL")).digest("hex");
    if (next === source) return;
    source = next;
    const saved = await readJson(SESSION_FILE);
    session = saved?.source === source ? saved : { source, cookie: "", attempted: false };
    pausedUntil = 0;
    namesLoaded = false;
    await writeJson(SESSION_FILE, session);
}

async function getCookie() {
    if (session.cookie) return session.cookie;
    if (session.attempted) throw new Error("认证已暂停，请更新 LINKINGCLOUD_AUTH_URL 后再试");
    const params = authParams();
    // 在发请求前记下尝试，避免失败或重启后反复消费同一个 code。
    session.attempted = true;
    await writeJson(SESSION_FILE, session);
    const response = await fetch(`${HOST}//Account/AuthLogin?${params}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
    });
    for (const item of response.headers.getSetCookie()) {
        const match = /^FuWuChuang=([^;]+)/.exec(item);
        if (match && match[1] !== '""') session.cookie = match[0];
    }
    if (!session.cookie) {
        throw new Error(`认证未取得非空 FuWuChuang（HTTP ${response.status}），已暂停；请重新捕获认证 URL`);
    }
    await writeJson(SESSION_FILE, session);
    return session.cookie;
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

async function api(endpoint, body) {
    const response = await fetch(`${HOST}/YuYue/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: await getCookie() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) {
        session.cookie = "";
        session.attempted = true;
        await writeJson(SESSION_FILE, session);
        throw new Error("HTTP 401：会话失效，已暂停，请更新认证 URL");
    }
    if ([403, 405, 429].includes(response.status)) {
        const retryAfter = response.headers.get("retry-after");
        const retryMs = /^\d+$/.test(retryAfter || "")
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        pausedUntil = Date.now() + Math.max(30 * 60_000, retryMs || 0);
        throw new Error(`HTTP ${response.status}：停止本轮，至少延后 30 分钟`);
    }
    if (!response.ok) throw new Error(`医院接口 HTTP ${response.status}`);
    const data = decryptResponse(await response.json());
    if (!yes(data.responseResult?.isSuccess)) throw new Error("医院接口返回业务失败");
    return data;
}

async function fetchNames() {
    const data = await api("OrderDeptResources", {});
    const sources = [
        ["hospitalList", "hospitalID", "hospitalName"],
        ["deptLevel1List", "deptCode", "deptName"],
        ["deptLevel2List", "deptCode", "deptName"],
        ["deptResourceDocList", "docCode", "docName"],
    ];
    for (const [list, code, name] of sources) {
        for (const item of data[list] || []) nameMap.set(String(item[code]), item[name]);
    }
    namesLoaded = true;
}

async function fetchDoctorSlots(docCode) {
    const data = await api("OrderDocNoSources", { docCode });
    const days = data.docResourceDayList.filter(day => yes(day.isDay) && yes(day.isAvailable));
    const slots = [];
    // 不捕获单日错误：任何一天失败都使整轮失败，不能把缺失数据当成无号。
    for (const day of days) {
        const detail = await api("OrderDocNoSources", { docCode, day: day.date });
        for (const item of detail.docResourceResourceList.filter(item => yes(item.isAvailable))) {
            slots.push({
                docCode, date: day.date, time: item.timeEnd, memo: item.resourceMemo,
                haji: /初诊[:：]\s*有号/.test(item.timeEnd),
            });
        }
    }
    return slots;
}

async function fetchDepartmentSlots(deptCode) {
    const data = await api("OrderDocResources", { deptCode });
    return data.deptResourceDocNoSourceList.filter(item => yes(item.isAvailable)).map(item => ({
        docCode: item.docCode, date: item.day, time: "", memo: item.resourceMemo,
    }));
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

function buildMessage(target, doctor, slots) {
    const dept = doctor ? target.slice(0, target.lastIndexOf("_")) : target;
    const doctors = [...new Set(slots.map(slot => nameOf(slot.docCode)))];
    const days = [...new Set(slots.map(slot => slot.date))];
    const dateLabel = days.length === 1 ? days[0] : `${days[0]}起${days.length}天`;
    const title = [nameOf(dept), doctors.slice(0, 3).join("、") + (doctors.length > 3 ? `等${doctors.length}位` : ""),
        slots.some(slot => slot.haji) ? "初诊可约" : "可预约", dateLabel,
        `${slots.length}${doctor ? "个时段" : "条号源"}`].join("｜");
    const lines = [`# ${nameOf(dept)}${doctor ? ` · ${nameOf(target)}` : ""}`, "", title, ""];
    for (const day of days) {
        lines.push(`## ${day}（${new Date(`${day}T12:00:00`).toLocaleDateString("zh-CN", { weekday: "long" })}）`, "");
        for (const slot of slots.filter(slot => slot.date === day)) {
            const text = [nameOf(slot.docCode), slot.time, slot.memo].filter(Boolean).join("　");
            lines.push(`- ${slot.haji ? `**${text}**` : text}`);
        }
        lines.push("");
    }
    return { title, content: lines.join("\n") };
}

async function checkSlots(target, doctor) {
    let slots = doctor ? await fetchDoctorSlots(target) : await fetchDepartmentSlots(target);
    // 初诊过滤发生在对比前，复诊变化不会触发初诊提醒；科室接口没有初诊细分。
    if (doctor && yes(env("NOTIFY_HAJI_ONLY"))) slots = slots.filter(slot => slot.haji);
    slots.sort((a, b) => a.date.localeCompare(b.date) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const file = path.join(DIR, `${target}.last_result.json`);
    const snapshot = slots.map(slot => JSON.stringify(slot)).sort();
    if (JSON.stringify(await readJson(file)) === JSON.stringify(snapshot)) return;
    if (slots.length) {
        const { title, content } = buildMessage(target, doctor, slots);
        console.log(content);
        await sendNotification(title, content);
    }
    // 无号也推进到空快照；有号时必须等所有通知成功，否则下一轮重试。
    await writeJson(file, snapshot);
}

async function handleError(error, target) {
    // 不记录 fetch 的 URL/cause 或服务端正文，避免凭据和患者信息进入日志/推送。
    const message = error instanceof TypeError || error instanceof SyntaxError ? "请求或响应处理失败" : error.message;
    console.error(`[${new Date().toLocaleString()}] ${target}: ${message}`);
    const log = await readJson(ERROR_FILE) || {};
    const key = `${target}:${message}`;
    if (Date.now() - (log[key] || 0) < DAY) return;
    try {
        await sendNotification(`监听出错｜${nameOf(target)}`, `${message}\n\n时间：${new Date().toLocaleString()}`);
        log[key] = Date.now();
        await writeJson(ERROR_FILE, log);
    } catch {
        console.error("错误通知未送达，后续轮次将重试");
    }
}

async function main() {
    const target = process.argv[2];
    if (!/^\d+_\d+_\d+(?:_\d+)?$/.test(target || "")) {
        console.log("用法：pnpm start <科室编码或医生编码>\n编码须从当前页面确认，科室三段、医生四段。详情见 README.md。");
        return;
    }
    const doctor = target.split("_").length === 4;
    for (;;) {
        try {
            await refreshConfig();
            if (Date.now() >= pausedUntil) {
                if (!namesLoaded) await fetchNames();
                await checkSlots(target, doctor);
            }
        } catch (error) {
            await handleError(error, target);
        }
        // 首轮也 await 完成后才安排下一轮，长轮次跳过错过的整分钟。
        await new Promise(resolve => setTimeout(resolve, 60_000 - Date.now() % 60_000));
    }
}

main().catch(() => {
    console.error("本地配置或状态文件读写失败，监听已停止");
    process.exitCode = 1;
});
