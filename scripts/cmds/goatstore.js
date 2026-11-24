// code from goatstore
// api: https://store.cloudrx.cyou
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.GOATSTORE_DEBUG || "").trim());
function log(...args) { if (DEBUG) console.log(...args); }
function logError(...args) { if (DEBUG) console.error(...args); }

module.exports = {
  config: {
    name: "goatstore",
    aliases: ["gs", "cmdstore", "commandstore"],
    version: "21.0.0",
    author: "rX",
    role: 2,
    countDown: 15,
    shortDescription: "GoatBot Store — Search, AutoUpdate, Install, Upload, AutoSync",
    longDescription: "Browse, install, upload, and autosync GoatBot commands and events from the MiraiStore API. Auto-detects your cmds/events folder naming. The bare-menu shows only the daily-use commands — every subcommand lives here in the guide.",
    category: "system",
    guide: {
      en:
        "{pn} — Menu / Notifications\n" +
        "{pn} <id | file name> — Search commands only\n" +
        "{pn} -a <name> — All files by an author\n" +
        "{pn} -al <alias> — Search commands by alias\n" +
        "{pn} -c <goat|mirai|other|category> — Browse a framework or category\n" +
        "{pn} -c goatcmd|goatevent|miraicmd|miraievent — Browse one file-type bucket\n" +
        "{pn} -e <name> — Search events\n" +
        "{pn} -e install <id> — Install as event\n" +
        "{pn} -e upload <fileName> — Upload an event file\n" +
        "{pn} n — Today's updates\n" +
        "{pn} list [page] — Command list\n" +
        "{pn} list event [page] — Event list\n" +
        "{pn} install <id> — Install a command\n" +
        "{pn} like <id> — Like\n" +
        "{pn} trend — Trending\n" +
        "{pn} upload <fileName> — Upload a command file\n" +
        "{pn} -s — Settings (AutoSync, AutoUpdate, Frame)\n" +
        "{pn} sync — Manual sync\n" +
        "{pn} dirs — Show & re-detect cmds/events locations\n" +
        "Reply \"in\" to a single result — Install\n" +
        "Reply \"in <id>\" to a list result — Install"
    },
    autoSync: false
  }
};

const PRIMARY_BASE = (() => {
  const v = process.env.STORE_API_BASE;
  return v && v.startsWith("http") ? v.replace(/\/$/, "") : "https://store.cloudrx.cyou";
})();

const STORE_API_KEY = String(process.env.STORE_API_KEY || "").trim();
const keyHeaders = () => (STORE_API_KEY ? { "x-api-key": STORE_API_KEY } : {});

const REQ_WINDOW_MS = 10 * 1000;
const REQ_MAX_PER_WINDOW = 12;
const REQ_MIN_GAP_MS = 150;

const BOT_FP = `bot:${module.exports.config.author || "goatstore"}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _reqTimes = [];
let _reqChain = Promise.resolve();

function _schedule(makeReq) {
  const run = _reqChain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (_reqTimes.length && now - _reqTimes[0] >= REQ_WINDOW_MS) _reqTimes.shift();
      if (_reqTimes.length >= REQ_MAX_PER_WINDOW) {
        await sleep(REQ_WINDOW_MS - (now - _reqTimes[0]) + 10);
        continue;
      }
      const last = _reqTimes[_reqTimes.length - 1] || 0;
      if (now - last < REQ_MIN_GAP_MS) { await sleep(REQ_MIN_GAP_MS - (now - last)); continue; }
      break;
    }
    _reqTimes.push(Date.now());
    return makeReq();
  });
  _reqChain = run.then(() => {}, () => {});
  return run;
}

function blockedMs(err) {
  const s = Number(err?.response?.data?.remainingSeconds);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

async function _send(makeReq, attempt = 0) {
  try {
    return await _schedule(makeReq);
  } catch (err) {
    const wait = blockedMs(err);
    if (wait > 0 && attempt < 2) {
      const ms = Math.min(wait, 5 * 60 * 1000) + 500;
      logError(`[goatstore] store rate limit hit — waiting ${Math.ceil(ms / 1000)}s before retrying`);
      await sleep(ms);
      return _send(makeReq, attempt + 1);
    }
    throw err;
  }
}

async function storeGet(pathSuffix, config = {}) {
  const cfg = { ...config, params: { ...(config.params || {}) }, headers: { ...(config.headers || {}), ...keyHeaders() } };
  if (!cfg.params.clientFp && !/clientFp=/.test(pathSuffix)) cfg.params.clientFp = BOT_FP;
  return _send(() => axios.get(`${PRIMARY_BASE}${pathSuffix}`, cfg));
}

async function storePost(pathSuffix, data, config = {}) {
  const body = { ...(data || {}) };
  if (!body.clientFp) body.clientFp = BOT_FP;
  const cfg = { ...config, headers: { ...(config.headers || {}), ...keyHeaders() } };
  return _send(() => axios.post(`${PRIMARY_BASE}${pathSuffix}`, body, cfg));
}

async function checkAbuseGuard(senderID) {
  try {
    const res = await storeGet(`/miraistore/ratelimit/status`, {
      params: { clientFp: senderID },
      timeout: 6000
    });
    return res.data || { blocked: false };
  } catch (_) {
    return { blocked: false };
  }
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

const userSeenNoti = new Map();
const AUTOSYNC_CACHE_PATH = path.join(process.cwd(), "goatstore_sync_cache.json");
const DIR_CACHE_PATH = path.join(process.cwd(), "goatstore_dircache.json");

let _updateCheckCache = null;
const UPDATE_CHECK_INTERVAL = 1000 * 60 * 30;

const MAX_EDITS_PER_MESSAGE = 5;

function getPrefix(threadData) {
  try {
    if (threadData?.data?.prefix) return threadData.data.prefix;
    if (global.GoatBot?.config?.prefix) return global.GoatBot.config.prefix;
  } catch (_) {}
  return "!";
}

function loadSyncCache() {
  try { return JSON.parse(fs.readFileSync(AUTOSYNC_CACHE_PATH, "utf8")); }
  catch { return {}; }
}

function saveSyncCache(cache) {
  try { fs.writeFileSync(AUTOSYNC_CACHE_PATH, JSON.stringify(cache, null, 2)); }
  catch (_) {}
}

let _autoupdateInFlight = false;

async function stampUploadCode(code) {
  return `// code from goatstore\n// api: ${PRIMARY_BASE}\n${code}`;
}

function hashContent(content) {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
  return h.toString(16);
}

function parseVer(v) {
  return String(v).split(".").map(n => parseInt(n) || 0);
}

function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function extractConfigBlock(src) {
  const idx = src.search(/\bconfig\s*[:=]\s*\{/);
  if (idx === -1) return src;
  const braceStart = src.indexOf("{", idx);
  if (braceStart === -1) return src;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return src.slice(braceStart);
}

function detectFramework(code) {
  const configBlock = extractConfigBlock(code);

  const hasCredits    = /\bcredits\s*:/.test(configBlock);
  const hasPermission = /\bhasPerm(?:i)?ssion\s*[:(]/i.test(configBlock);
  if (hasCredits && hasPermission) return "mirai";

  const hasAuthor = /\bauthor\s*:/.test(configBlock);
  const hasRole   = /\brole\s*:/.test(configBlock);
  if (hasAuthor && hasRole) return "goat";

  const isGoatStructure =
    /module\.exports\s*=\s*\{/.test(code) &&
    /onStart\s*[:(]|onChat\s*[:(]|onLoad\s*[:(]/.test(code);
  if (isGoatStructure) return "goat";

  const isMiraiStructure =
    /module\.exports\.config\s*=/.test(code) ||
    /module\.exports\.run\s*=/.test(code);
  if (isMiraiStructure) return "mirai";

  return "other";
}

const EVENTS_NAME_PATTERNS = ["events", "event"];
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".github", "dist", "build"]);

function loadDirCache() {
  try { return JSON.parse(fs.readFileSync(DIR_CACHE_PATH, "utf8")); }
  catch { return {}; }
}

function saveDirCache(cache) {
  try { fs.writeFileSync(DIR_CACHE_PATH, JSON.stringify(cache, null, 2)); }
  catch (_) {}
}

let _dirCache = loadDirCache();

function scanForDir(startDir, namePatterns, maxDepth = 2) {
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (SCAN_SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith(".")) continue;
      const lower = ent.name.toLowerCase();
      const full = path.join(dir, ent.name);
      if (namePatterns.includes(lower)) return full;
      if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

function getCmdsDir(forceRescan = false) {
  if (!forceRescan && _dirCache.cmdsDir && fs.existsSync(_dirCache.cmdsDir)) return _dirCache.cmdsDir;
  const dir = __dirname;
  _dirCache.cmdsDir = dir;
  saveDirCache(_dirCache);
  return dir;
}

function getEventsDir(forceRescan = false) {
  if (!forceRescan && _dirCache.eventsDir && fs.existsSync(_dirCache.eventsDir)) return _dirCache.eventsDir;
  const cmdsDir = getCmdsDir(forceRescan);
  const parent = path.dirname(cmdsDir);
  const roots = [...new Set([parent, path.dirname(parent), process.cwd()])];
  let dir = null;
  for (const root of roots) {
    dir = scanForDir(root, EVENTS_NAME_PATTERNS, 3);
    if (dir) break;
  }
  if (!dir) dir = path.join(parent, "events");
  _dirCache.eventsDir = dir;
  saveDirCache(_dirCache);
  return dir;
}

function findLocalFile(fileName, kind) {
  const dirs = kind === "event" ? [getEventsDir()] : [getCmdsDir(), getEventsDir()];
  for (const dir of dirs) {
    const direct = path.join(dir, fileName);
    if (fs.existsSync(direct)) return { filePath: direct, dirs };
    const withExt = direct.endsWith(".js") ? null : direct + ".js";
    if (withExt && fs.existsSync(withExt)) return { filePath: withExt, dirs };
  }
  return { filePath: null, dirs };
}

function relDir(p) {
  const rel = path.relative(process.cwd(), p);
  return rel || ".";
}

function fileNotFoundMsg(fileName, dirs, prefix) {
  return (
    `❌ File not found: "${fileName}"\nSearched in:\n` +
    dirs.map(d => `• ${relDir(d)}`).join("\n") +
    `\n💡 Wrong location? Check with: ${prefix}gs dirs`
  );
}

async function checkSelfUpdate() {
  const now = Date.now();
  if (_updateCheckCache && (now - _updateCheckCache.checkedAt) < UPDATE_CHECK_INTERVAL)
    return _updateCheckCache.result;
  try {
    const res = await storeGet(`/miraistore/search?q=goatstore&limit=10&framework=goat&kind=command`);
    const cmds = Array.isArray(res.data?.commands) ? res.data.commands : [];
    const match =
      cmds.find(c => c.name?.toLowerCase() === "goatstore" && c.author === module.exports.config.author) ||
      cmds.find(c => c.name?.toLowerCase() === "goatstore");
    if (!match) { _updateCheckCache = { checkedAt: now, result: null }; return null; }
    const current = module.exports.config.version;
    const latest = match.version || "N/A";
    const result = {
      hasUpdate: cmpVer(latest, current) > 0,
      currentVersion: current,
      latestVersion: latest,
      latestId: match.id,
      description: match.description || match.changelog || ""
    };
    _updateCheckCache = { checkedAt: now, result };
    return result;
  } catch (_) { return null; }
}

async function getTodayUpdates(senderID = null) {
  try {
    const res = await storeGet(`/miraistore/list?limit=50&framework=goat&clientFp=${encodeURIComponent(senderID || "")}`);
    const today = new Date().toDateString();
    return (res.data.commands || [])
      .filter(cmd => new Date(cmd.uploadDate).toDateString() === today)
  } catch (_) { return []; }
}

async function getTrending(limit = 5) {
  const parse = d => Array.isArray(d) ? d : (Array.isArray(d?.commands) ? d.commands : null);
  try {
    const res = await storeGet(`/miraistore/trending?limit=${limit}`);
    const list = parse(res.data);
    if (list) return list.slice(0, limit);
  } catch (_) {}
  return null;
}

async function fetchBotAvatar(api) {
  let botId = null;
  try { botId = api.getCurrentUserID(); } catch (_) {}
  if (!botId && global.GoatBot?.botID) botId = global.GoatBot.botID;
  if (!botId) return null;

  let info = null;
  try {
    const res = await api.getUserInfo(botId);
    info = res && (res[botId] || res[String(botId)]) ? (res[botId] || res[String(botId)]) : res;
  } catch (_) { return null; }
  if (!info) return null;

  const url =
    info.thumbSrc ||
    info.profileUrl ||
    info.profilePictureUrl ||
    info.imageSrc ||
    info.image ||
    info.avatar ||
    (info.profilePicture && (info.profilePicture.uri || info.profilePicture.url)) ||
    (info.thumbSrcBig) ||
    null;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

async function reportBotAvatar(api, { force = false } = {}) {
  const author = module.exports.config.author;
  if (!author) return;
  try {
    const avatarUrl = await fetchBotAvatar(api);
    if (!avatarUrl) return;

    if (!force) {
      try {
        const cur = await storeGet(`/miraistore/profile?author=${encodeURIComponent(author)}`);
        if (cur.data && cur.data.avatarUrl === avatarUrl) return;
      } catch (_) {}
    }

    await storePost(`/miraistore/profile`, { author, avatarUrl, clientFp: `avatar:${author}` });
    log(`[goatstore] developer avatar reported for "${author}"`);
  } catch (err) {
    logError("[goatstore] avatar report failed:", err.response?.data?.error || err.message);
  }
}

async function runAutoSync() {
  const folders = [
    { dir: getCmdsDir(), kind: "command" },
    { dir: getEventsDir(), kind: "event" }
  ].filter(f => fs.existsSync(f.dir));

  if (!folders.length) return;

  const cache = loadSyncCache();

  let rewritesThisMinute = 0;
  const paceRewrites = async (isRewrite) => {
    if (!isRewrite) return;
    rewritesThisMinute++;
    if (rewritesThisMinute >= 2) {
      await new Promise(r => setTimeout(r, 60 * 1000));
      rewritesThisMinute = 0;
    }
  };

  for (const { dir, kind } of folders) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const cacheKey = `${kind}:${file}`;
      let content;
      try { content = fs.readFileSync(fullPath, "utf8"); } catch (_) { continue; }

      const hash = hashContent(content);
      if (cache[cacheKey] === hash) continue;

      try { new Function(content); } catch (_) { continue; }
      const fw = detectFramework(content);
      if (fw !== "goat") {
        log(`[goatstore-sync] Skipped ${file}: detected as "${fw}" (only GoatBot files are synced).`);
        continue;
      }

      try {
        const author = content.match(/author\s*:\s*["'`](.*?)["'`]/)?.[1]
                    || content.match(/credits\s*:\s*["'`](.*?)["'`]/)?.[1]
                    || "Unknown";
        const category = content.match(/category\s*:\s*["'`](.*?)["'`]/)?.[1] || "Uncategorized";
        const stampedContent = await stampUploadCode(content);
        const res = await storePost(`/miraistore/upload`, { rawCode: stampedContent, framework: "goat", kind, author, category });
        if (res.data?.error) {
          logError(`[goatstore-sync] Upload skipped for ${file}: ${res.data.message || res.data.error}`);
        } else if (res.data?.pending) {
          log(`[goatstore-sync] ${file}: submitted for admin review.`);
          cache[cacheKey] = hash;
        } else if (res.data?.updated) {
          log(`[goatstore-sync] ${file}: updated existing entry (ID: ${res.data.id}) to v${res.data.version}.`);
          cache[cacheKey] = hash;
          await paceRewrites(true);
        } else {
          log(`[goatstore-sync] ${file}: uploaded as new entry (ID: ${res.data.id}).`);
          cache[cacheKey] = hash;
        }
      } catch (err) {
        logError(`[goatstore-sync] Upload request fail for ${file}:`, err.response?.data?.error || err.message);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  saveSyncCache(cache);
}

const buildBar = pct => "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
const frames = ["◖", "◕", "◔", "◓", "◒", "◑", "◐"];

async function animateInstall(api, threadID, name) {
  const steps = [
    { label: "Downloading source",  pct: 30,  delay: 600 },
    { label: "Verifying integrity", pct: 60,  delay: 900 },
    { label: "Writing to disk",     pct: 85,  delay: 700 },
    { label: "Registering command", pct: 100, delay: 600 }
  ];
  const info = await api.sendMessage(`📦 Installing ${name}...\n\n◖ Fetching package info...\n[░░░░░░░░░░] 0%`, threadID);
  for (let i = 0; i < steps.length; i++) {
    await new Promise(r => setTimeout(r, steps[i].delay));
    await api.editMessage(`📦 Installing ${name}...\n\n${frames[i]} ${steps[i].label}...\n[${buildBar(steps[i].pct)}] ${steps[i].pct}%`, info.messageID);
  }
  return info.messageID;
}

async function animateUpload(api, threadID, name) {
  const steps = [
    { label: "Reading file",         pct: 30,  delay: 500 },
    { label: "Uploading directly",   pct: 70,  delay: 900 },
    { label: "Finalizing registration", pct: 100, delay: 500 }
  ];
  const info = await api.sendMessage(`📤 Uploading ${name}...\n\n◖ Preparing upload...\n[░░░░░░░░░░] 0%`, threadID);
  for (let i = 0; i < steps.length; i++) {
    await new Promise(r => setTimeout(r, steps[i].delay));
    await api.editMessage(`📤 Uploading ${name}...\n\n${frames[i]} ${steps[i].label}...\n[${buildBar(steps[i].pct)}] ${steps[i].pct}%`, info.messageID);
  }
  return info.messageID;
}

function autoloadCommand(filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const cmd = require(filePath);
    if (cmd?.config?.name) {
      const name = cmd.config.name.toLowerCase();
      global.GoatBot.commands.set(name, cmd);
      if (Array.isArray(cmd.config.aliases))
        cmd.config.aliases.forEach(a => global.GoatBot.commands.set(a.toLowerCase(), cmd));
      if (typeof cmd.onLoad === "function") cmd.onLoad({});
      return { success: true, name };
    }
    return { success: false, reason: "Missing config.name." };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

const _installLocks = new Map();

async function doInstall(api, threadID, senderID, id, forceKind = null) {
  const key = `${threadID}:${id}`;
  const now = Date.now();
  const prev = _installLocks.get(key);
  if (prev && now - prev < 8000) return;
  _installLocks.set(key, now);
  try {
    return await installCommand(api, threadID, senderID, id, forceKind);
  } finally {
    setTimeout(() => {
      if (_installLocks.get(key) === now) _installLocks.delete(key);
    }, 8000).unref?.();
  }
}

async function installCommand(api, threadID, senderID, id, forceKind = null) {
  let cmdData = null;
  try {
    const res = await storeGet(`/miraistore/search?q=${encodeURIComponent(id)}&clientFp=${encodeURIComponent(senderID || "")}`);
    const data = res.data;
    if (!isNaN(id) && data?.rawCode && !Array.isArray(data)) cmdData = data;
    else if (Array.isArray(data?.commands)) cmdData = data.commands.find(c => String(c.id) === String(id));
    if (!cmdData?.rawCode) return api.sendMessage("❌ Command not found or rawCode missing.", threadID);
  } catch (err) {
    return api.sendMessage(err.response?.data?.message || "❌ Failed to fetch command info.", threadID);
  }

  if (cmdData.framework !== "goat")
    return api.sendMessage(
      `❌ This is not a GoatBot file!\n` +
      `├‣ Category : ${cmdData.framework || "unknown"}\n` +
      `╰────────────◊\n` +
      `⚠️ Only goat-framework commands/events can be installed here.`,
      threadID
    );

  try { new Function(cmdData.rawCode); }
  catch (err) { return api.sendMessage(`❌ Syntax error in remote code.\n${err.message}`, threadID); }

  const displayName = cmdData.name || `gs_${id}`;
  const isEvent = forceKind === "event" ? true : forceKind === "command" ? false : cmdData.kind === "event";

  let pid;
  try { pid = await animateInstall(api, threadID, displayName); } catch (_) {}

  const fileName = displayName.replace(/\s+/g, "_") + ".js";
  const baseDir = process.cwd();
  const installDir = isEvent ? getEventsDir() : getCmdsDir();
  const filePath = path.join(installDir, fileName);
  const locLabel = path.relative(baseDir, filePath);

  try {
    if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(filePath, cmdData.rawCode, "utf-8");
  } catch (err) {
    if (pid) api.unsendMessage(pid);
    return api.sendMessage(`❌ Failed to write file:\n${err.message}`, threadID);
  }

  try { await storePost(`/miraistore/install/${cmdData.id}`, { clientFp: senderID }); } catch (_) {}

  const load = isEvent ? { success: false } : autoloadCommand(filePath);

  const msg =
    `✅ Installed Successfully!\n` +
    `╭─‣ Name : ${cmdData.name || "Unknown"}\n` +
    `├‣ Type : ${typeBadge(cmdData)}\n` +
    `├‣ Author : ${cmdData.author || "Unknown"}\n` +
    `├‣ Version : ${cmdData.version || "N/A"}\n` +
    `├‣ Category : ${cmdData.category || "N/A"}\n` +
    `├‣ ID : ${id}\n` +
    `├‣ Location : ${locLabel}\n` +
    `╰────────────◊\n` +
    (load.success ? `🚀 "${load.name}" is now live! No restart needed.`
      : isEvent ? `⚠️ Event saved. Restart bot to apply.`
      : `⚠️ Autoload failed: ${load.reason}`);

  if (pid) {
    try { await api.editMessage(msg, pid); setTimeout(() => api.unsendMessage(pid).catch(() => {}), 5000); }
    catch (_) { api.sendMessage(msg, threadID); }
  } else api.sendMessage(msg, threadID);
}

async function doSelfUpdateSilent(api, threadID, selfUpdate) {
  let cmdData = null;
  try {
    const res = await storeGet(`/miraistore/search?q=${encodeURIComponent(selfUpdate.latestId)}`);
    const data = res.data;
    if (!isNaN(selfUpdate.latestId) && data?.rawCode && !Array.isArray(data)) cmdData = data;
    else if (Array.isArray(data?.commands)) cmdData = data.commands.find(c => String(c.id) === String(selfUpdate.latestId));
    if (!cmdData?.rawCode) return false;
  } catch (_) { return false; }

  try { new Function(cmdData.rawCode); }
  catch (_) { return false; }

  try {
    fs.writeFileSync(__filename, cmdData.rawCode, "utf-8");
  } catch (_) { return false; }

  _updateCheckCache = { checkedAt: Date.now(), result: { ...selfUpdate, hasUpdate: false } };

  try { await storePost(`/miraistore/install/${cmdData.id}`, { }); } catch (_) {}

  const changelog = (cmdData.description || cmdData.changelog || "No changelog provided.").trim();
  const load = autoloadCommand(__filename);

  if (api && threadID) {
    const msg =
      `♻️ Auto-Updated GoatStore!\n` +
      `╭─‣ Version : v${cmdData.version || selfUpdate.latestVersion}\n` +
      `├‣ ID : ${cmdData.id}\n` +
      `╰────────────◊\n` +
      `📝 Changelog:\n${changelog}\n\n` +
      (load.success ? `🚀 Live now! No restart needed.` : `⚠️ Reload failed (${load.reason}) — restart bot to apply.`);
    api.sendMessage(msg, threadID).catch(() => {});
  }
  return true;
}

async function maybeAutoUpdate(api, threadID) {
  if (_autoupdateInFlight) return;
  if (!loadSettings().autoUpdate) return;
  const selfUpdate = await checkSelfUpdate();
  if (!selfUpdate?.hasUpdate) return;
  _autoupdateInFlight = true;
  try {
    await doSelfUpdateSilent(api, threadID, selfUpdate);
  } finally {
    _autoupdateInFlight = false;
  }
}

const SETTINGS_PATH = path.join(process.cwd(), "goatstore_settings.json");
let _settingsCache = null;

function loadSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCache.at < 1500) return _settingsCache.val;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch (_) {}
  const val = {
    autoSync: typeof raw.autoSync === "boolean" ? raw.autoSync : module.exports.config.autoSync !== false,
    autoUpdate: typeof raw.autoUpdate === "boolean" ? raw.autoUpdate : true,
    frame: [1, 2, 3].includes(raw.frame) ? raw.frame : 1
  };
  _settingsCache = { at: now, val };
  return val;
}

function saveSettings(val) {
  _settingsCache = { at: Date.now(), val: { ...val } };
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(val, null, 2)); } catch (_) {}
}

function skinFrame3(text) {
  const lines = String(text).split("\n");
  const out = [];
  const kv = (t) => t.replace(/^(.+?) : +/, "$1: ");
  let inBlock = false;
  let blockId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    if (/^\s*╰‣ reply in <id> for install$/.test(line)) continue;

    if ((m = line.match(/^╭─‣ (.*)$/))) {
      inBlock = true;
      blockId = null;
      const c = m[1];
      let title = c;
      let first = null;
      if (/ 〄$/.test(c)) {
        title = "FILE INFO";
        first = `Name: ${c.replace(/ 〄$/, "")}`;
      } else if (/^.+? : /.test(c)) {
        const key = c.match(/^(.+?) : /)[1];
        title = /^name$/i.test(key) ? "FILE INFO" : /^\d+\./.test(key) ? "SETTINGS" : "INFO";
        first = kv(c);
      }
      out.push(`╭─「 ${title} 」`, "│");
      if (first) out.push(`│ ✧ ${first}`);
      continue;
    }

    if (inBlock && (m = line.match(/^├‣ (.*)$/))) {
      const idm = m[1].match(/^ID ?: *(\S+)/);
      if (idm) blockId = idm[1];
      out.push(`│ ✧ ${kv(m[1])}`);
      continue;
    }

    if (inBlock && line === "╰────────────◊") {
      inBlock = false;
      const up = lines[i + 1] && lines[i + 1].match(/^ ✰ Upload : (.*)$/);
      if (up) {
        out.push("│", `│ ✰ Upload: ${up[1]}`);
        out.push(blockId ? `╰─➤ Reply with ${blockId} to install` : "╰──────────➤");
        i++;
      } else {
        out.push("╰──────────➤");
      }
      continue;
    }

    out.push(line.replace(/^╭‣ /, "╭─➤ "));
  }
  return out.join("\n");
}

function skinWith(text, frame) {
  if (typeof text !== "string") return text;
  if (frame === 3) return skinFrame3(text);
  if (frame !== 2) return text;
  return text
    .replace(/├‣ ([^\n]*)\n╰────────────◊/g, "╰ $1")
    .replace(/╭─‣ /g, "╭─❯ ")
    .replace(/├‣ /g, "├ ")
    .replace(/╰────────────◊/g, "╰")
    .replace(/╭‣ /g, "╭ ")
    .replace(/╰‣ /g, "╰ ");
}

function wrapApi(api) {
  if (!api || api.__gsWrapped) return api;
  const skin = (m) => {
    const f = loadSettings().frame;
    if (typeof m === "string") return skinWith(m, f);
    if (m && typeof m.body === "string") return { ...m, body: skinWith(m.body, f) };
    return m;
  };
  return new Proxy(api, {
    get(target, prop) {
      if (prop === "__gsWrapped") return true;
      if (prop === "sendMessage") return (m, ...rest) => target.sendMessage(skin(m), ...rest);
      if (prop === "editMessage") return (m, ...rest) => target.editMessage(skin(m), ...rest);
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}

function replayApi(api, noteID) {
  let used = false;
  return new Proxy(api, {
    get(target, prop) {
      if (prop === "sendMessage") {
        return async (m, ...rest) => {
          if (!used) {
            used = true;
            try { await target.editMessage(m, noteID); return { messageID: noteID }; } catch (_) {}
          }
          return target.sendMessage(m, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}

async function updateAndReplay({ api, event, args, threadData }) {
  const selfUpdate = await checkSelfUpdate();
  if (!selfUpdate?.hasUpdate) return false;
  _autoupdateInFlight = true;
  let noteID = null;
  let fresh = null;
  try {
    const changelog = String(selfUpdate.description || "").trim();
    const sent = await api.sendMessage(
      `♻️ Auto-Updating GoatStore...\n` +
      `╭─‣ v${selfUpdate.currentVersion} ➜ v${selfUpdate.latestVersion}\n` +
      `├‣ ID : ${selfUpdate.latestId}\n` +
      `╰────────────◊\n` +
      (changelog ? `📝 Changelog:\n${changelog}\n\n` : "") +
      `⏳ Please wait...`,
      event.threadID
    );
    noteID = sent?.messageID || null;

    const ok = await doSelfUpdateSilent(null, null, selfUpdate);
    if (!ok) {
      if (noteID) api.unsendMessage(noteID).catch(() => {});
      return false;
    }
    await sleep(1200);

    fresh = global.GoatBot?.commands?.get("goatstore");
    if (!fresh || fresh === module.exports || typeof fresh.onStart !== "function") {
      if (noteID) api.unsendMessage(noteID).catch(() => {});
      return false;
    }
  } catch (_) {
    if (noteID) api.unsendMessage(noteID).catch(() => {});
    return false;
  } finally {
    _autoupdateInFlight = false;
  }

  try {
    const target = noteID ? replayApi(api, noteID) : api;
    await fresh.onStart({ api: target, event, args, threadData, __gsSkipUpdate: true });
  } catch (_) {}
  return true;
}

const FRAME_IDS = [1, 2, 3];

function settingsView(s) {
  const sample = `╭─‣ Command Name 〄\n├‣ ID : 12\n├‣ Author : rX\n╰────────────◊\n ✰ Upload : Wed Sep 09 2026`;
  const top = skinWith(
    `⚙️ GoatStore Settings\n\n` +
    `╭─‣ 1. Auto Sync : ${s.autoSync ? "ON ✅" : "OFF ❌"}\n` +
    `├‣ 2. Auto Update : ${s.autoUpdate ? "ON ✅" : "OFF ❌"}\n` +
    `╰────────────◊\n\n` +
    `🖼️ Frames`,
    s.frame
  );
  const frames = FRAME_IDS.map((f, i) =>
    `${i + 3}. Frame ${f}${s.frame === f ? " ✅ (current)" : ""}\n${skinWith(sample, f)}`
  ).join("\n\n");
  return `${top}\n\n${frames}\n\n💬 Reply 1-${FRAME_IDS.length + 2} to change`;
}

async function handleSettingsReply(rawApi, event, Reply) {
  const { threadID, body, senderID } = event;
  if (senderID !== Reply.senderID) return;
  const t = String(body || "").trim();
  const s = { ...loadSettings() };

  if (t === "1") s.autoSync = !s.autoSync;
  else if (t === "2") s.autoUpdate = !s.autoUpdate;
  else if (/^\d+$/.test(t) && FRAME_IDS[Number(t) - 3]) s.frame = FRAME_IDS[Number(t) - 3];
  else return;
  saveSettings(s);

  const text = settingsView(s);
  let id = Reply.messageID;
  try { await rawApi.editMessage(text, id); }
  catch (_) {
    try { const sent = await rawApi.sendMessage(text, threadID); id = sent.messageID; }
    catch (__) { return; }
  }
  global.GoatBot.onReply.set(id, { ...Reply, messageID: id });
}

function typeBadge(cmd) {
  if (cmd.framework === "goat")  return cmd.kind === "event" ? "🐐 G-Event" : "🐐 G-Bot";
  if (cmd.framework === "mirai") return cmd.kind === "event" ? "🌌 Mirai-E" : "🌌 Mirai";
  if (cmd.framework === "discord")  return cmd.kind === "event" ? "💬 D-Event" : "💬 Discord";
  if (cmd.framework === "telegram") return cmd.kind === "event" ? "✈️ TG-Event" : "✈️ Telegram";
  return "📦 Other";
}

const BUCKET_ALIASES = {
  goatcmd: "goat-command", goatcommand: "goat-command",
  goatevent: "goat-event",
  miraicmd: "mirai-command", miraicommand: "mirai-command",
  miraievent: "mirai-event",
  discordcmd: "discord-command", discordcommand: "discord-command",
  discorde: "discord-event", discordevent: "discord-event",
  tgcmd: "telegram-command", telegramcmd: "telegram-command",
  tgevent: "telegram-event", telegramevent: "telegram-event",
  other: "other", unsorted: "unsorted"
};

const BUCKET_LABELS = {
  "goat-command": "GoatBot Commands",
  "goat-event": "GoatBot Events",
  "mirai-command": "Mirai Commands",
  "mirai-event": "Mirai Events",
  "discord-command": "Discord Commands",
  "discord-event": "Discord Events",
  "telegram-command": "Telegram Commands",
  "telegram-event": "Telegram Events",
  other: "Other / Scripts",
  unsorted: "Unclassified"
};

function withReplyFooter(msg, total) {
  if (total === 1) return msg.replace(/\n+$/, "\n") + `  ╰‣ reply in <id> for install`;
  return msg + `╰‣ reply in <id> for install`;
}

function authorLine(cmd) {
  const v = cmd.version && cmd.version !== "N/A" ? ` (v${cmd.version})` : "";
  return `${cmd.author || "Unknown"}${v}`;
}

function resultBlock(cmd) {
  const nameLine = cmd.name;
  return (
    `╭─‣ ${nameLine} 〄\n` +
    `├‣ ID : ${cmd.id}\n` +
    `├‣ Type : ${typeBadge(cmd)}\n` +
    `├‣ Author : ${cmd.author || "Unknown"}\n` +
    `├‣ Version : ${cmd.version && cmd.version !== "N/A" ? ` ${cmd.version}` : " N/A"}\n` +
    `├‣ Category : ${cmd.category}\n` +
    `╰────────────◊\n` +
    ` ✰ Upload : ${new Date(cmd.uploadDate || Date.now()).toDateString()}\n\n`
  );
}

function listBlock(cmd) {
  const nameLine = cmd.name;
  return (
    `╭─‣ ${nameLine} 〄\n` +
    `├‣ ID : ${cmd.id}\n` +
    `├‣ Author : ${cmd.author || "Unknown"}\n` +
    `├‣ Version : ${cmd.version && cmd.version !== "N/A" ? ` ${cmd.version}` : " N/A"}\n` +
    `├‣ Category : ${cmd.category}\n` +
    `╰────────────◊\n` +
    ` ✰ Upload : ${new Date(cmd.uploadDate || Date.now()).toDateString()}\n\n`
  );
}

async function sendListPage(api, threadID, senderID, kind, page, limit = 10, prefix = "!") {
  const offset = (page - 1) * limit;
  try {
    const res = await storeGet(`/miraistore/list?limit=${limit}&offset=${offset}&framework=goat&kind=${kind}&clientFp=${encodeURIComponent(senderID || "")}`);
    const data = res.data;
    if (!Array.isArray(data.commands) || !data.commands.length)
      return api.sendMessage("❌ No results found for this page.", threadID);

    const totalPages = Math.ceil(data.total / limit);
    const label = kind === "event" ? "GoatBot Events" : "GoatBot Commands";
    let msg = `📂 ${label} — Page ${page}/${totalPages} (${data.total} total)\n\n`;
        data.commands.forEach(cmd => { msg += listBlock(cmd); });
    if (totalPages > 1) msg += `⏤͟͟͞͞  Page ${page}/${totalPages}\n╭‣ React or reply p ${page + 1 <= totalPages ? page + 1 : page} for nxt pg\n`;
    msg = withReplyFooter(msg, data.total);

    const finalMsg = msg.trim();
    const sent = await api.sendMessage(finalMsg, threadID);
    {
      const h = { commandName: "goatstore", messageID: sent.messageID, listType: kind, page, totalPages, limit, mode: "list", senderID, editCount: 0 };
      global.GoatBot.onReply.set(sent.messageID, h);
      global.GoatBot.onReaction.set(sent.messageID, h);
    }
  } catch (_) { api.sendMessage("❌ List API error.", threadID); }
}

function searchTitle(query, filterOpts) {
  if (filterOpts.alias) return `🔎 Alias: "${query}"`;
  if (filterOpts.author) return `👤 Author: ${filterOpts.author}`;
  if (filterOpts.category && !query) return `📂 Category: ${filterOpts.category}`;
  if (filterOpts.bucket && !query) return `📂 ${BUCKET_LABELS[filterOpts.bucket] || filterOpts.bucket}`;
  if (filterOpts.framework && !query) return `📂 Category: ${filterOpts.framework}`;
  if (filterOpts.kind === "event" && !query) return `📂 Events`;
  return `🔍 Search: "${query}"`;
}

async function sendSearchPage(api, threadID, senderID, query, page, limit = 5, prefix = "!", filterOpts = {}) {
  const offset = (page - 1) * limit;
  try {
    let qs = `/miraistore/search?limit=${limit}&offset=${offset}`;
    if (filterOpts.author) qs += `&author=${encodeURIComponent(filterOpts.author)}`;
    else qs += `&q=${encodeURIComponent(query || "")}`;
    if (filterOpts.alias) qs += `&alias=1`;
    if (filterOpts.bucket) qs += `&bucket=${filterOpts.bucket}`;
    if (filterOpts.framework) qs += `&framework=${filterOpts.framework}`;
    if (filterOpts.kind) qs += `&kind=${filterOpts.kind}`;
    if (filterOpts.category) qs += `&category=${encodeURIComponent(filterOpts.category)}`;
    qs += `&clientFp=${encodeURIComponent(senderID || "")}`;

    const res = await storeGet(qs);
    const data = res.data;
    if (!Array.isArray(data.commands) || !data.commands.length)
      return api.sendMessage(`❌ No results found${query ? ` for "${query}"` : ""}.`, threadID);

    const total = data.total || data.commands.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const title = searchTitle(query, filterOpts);

    let msg = `${title} (${total} found)\n\n`;
    data.commands.forEach(cmd => { msg += resultBlock(cmd); });
    if (totalPages > 1) msg += `⏤͟͟͞͞  Page ${page}/${totalPages}\n╭‣ React or reply p ${page + 1 <= totalPages ? page + 1 : page} for nxt pg\n`;
    msg = withReplyFooter(msg, total);

    const finalMsg = msg.trim();
    const sent = await api.sendMessage(finalMsg, threadID);
    const h = {
      commandName: "goatstore", messageID: sent.messageID, query,
      authorQuery: filterOpts.author || null, framework: filterOpts.framework || null,
      bucket: filterOpts.bucket || null,
      kind: filterOpts.kind || null, category: filterOpts.category || null,
      alias: filterOpts.alias || false,
      page, totalPages, limit, mode: "search", senderID, editCount: 0
    };
    global.GoatBot.onReply.set(sent.messageID, h);
    if (totalPages > 1) global.GoatBot.onReaction.set(sent.messageID, h);
  } catch (err) {
    api.sendMessage(err.response?.data?.message || "❌ Search API error.", threadID);
  }
}

async function renderListPageInto(messageID, kind, page, limit, senderID = null) {
  const offset = (page - 1) * limit;
  const res = await storeGet(`/miraistore/list?limit=${limit}&offset=${offset}&framework=goat&kind=${kind}&clientFp=${encodeURIComponent(senderID || "")}`);
  const data = res.data;
  if (!Array.isArray(data.commands) || !data.commands.length) return null;

  const totalPages = Math.ceil(data.total / limit);
  const label = kind === "event" ? "GoatBot Events" : "GoatBot Commands";
  let msg = `📂 ${label} — Page ${page}/${totalPages} (${data.total} total)\n\n`;
  data.commands.forEach(cmd => { msg += listBlock(cmd); });
  if (totalPages > 1) msg += `⏤͟͟͞͞  Page ${page}/${totalPages}\n╭‣ React or reply p ${page + 1 <= totalPages ? page + 1 : page} for nxt pg\n`;
  msg = withReplyFooter(msg, data.total);
  return { text: msg.trim(), totalPages };
}

async function renderSearchPageInto(query, page, limit, filterOpts = {}, senderID = null) {
  const offset = (page - 1) * limit;
  let qs = `/miraistore/search?limit=${limit}&offset=${offset}`;
  if (filterOpts.author) qs += `&author=${encodeURIComponent(filterOpts.author)}`;
  else qs += `&q=${encodeURIComponent(query || "")}`;
  if (filterOpts.alias) qs += `&alias=1`;
  if (filterOpts.bucket) qs += `&bucket=${filterOpts.bucket}`;
  if (filterOpts.framework) qs += `&framework=${filterOpts.framework}`;
  if (filterOpts.kind) qs += `&kind=${filterOpts.kind}`;
  if (filterOpts.category) qs += `&category=${encodeURIComponent(filterOpts.category)}`;
  qs += `&clientFp=${encodeURIComponent(senderID || "")}`;

  const res = await storeGet(qs);
  const data = res.data;
  if (!Array.isArray(data.commands) || !data.commands.length) return null;

  const total = data.total || data.commands.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const title = searchTitle(query, filterOpts);

  let msg = `${title} (${total} found)\n\n`;
  data.commands.forEach(cmd => { msg += resultBlock(cmd); });
  if (totalPages > 1) msg += `⏤͟͟͞͞  Page ${page}/${totalPages}\n╭‣ React or reply p ${page + 1 <= totalPages ? page + 1 : page} for nxt pg\n`;
  msg = withReplyFooter(msg, total);
  return { text: msg.trim(), totalPages };
}

async function uploadFile(api, threadID, filePath, kind, senderID = null) {
  let data;
  try { data = fs.readFileSync(filePath, "utf8"); }
  catch (err) { return api.sendMessage(`❌ Read failed:\n${err.message}`, threadID); }

  try { new Function(data); }
  catch (err) { return api.sendMessage(`❌ Syntax Error:\n${err.message}`, threadID); }

  const displayName = data.match(/name\s*:\s*["'`](.*?)["'`]/)?.[1] || path.basename(filePath);
  const detected = detectFramework(data);
  if (detected !== "goat")
    return api.sendMessage(
      `❌ Only GoatBot files can be uploaded here.\n` +
      `├‣ Detected : "${detected}" (this looks like a ${detected === "mirai" ? "Mirai" : "plain script"} file)\n` +
      `╰────────────◊`,
      threadID
    );

  let pid;
  try { pid = await animateUpload(api, threadID, displayName); } catch (_) {}

  try {
    const stampedData = await stampUploadCode(data);
    const body = { rawCode: stampedData, framework: "goat", kind };
    if (senderID) { body.uploaderID = senderID; body.clientFp = senderID; }
    const res = await storePost(`/miraistore/upload`, body);

    if (["Already exists", "Version already exists", "Version too low", "Not allowed", "Upload blocked"].includes(res.data?.error)) {
      if (pid) api.unsendMessage(pid);
      return api.sendMessage(
        `⚠️ Upload Blocked!\n` +
        `╭─‣ Name : ${displayName}\n` +
        (res.data.id ? `├‣ ID : ${res.data.id}\n` : "") +
        (res.data.currentVersion ? `├‣ Current : v${res.data.currentVersion}\n` : "") +
        `╰────────────◊\n` +
        `💡 ${res.data.message}`,
        threadID
      );
    }

    if (res.data?.error) {
      if (pid) api.unsendMessage(pid);
      return api.sendMessage(
        `⚠️ Upload Failed!\n` +
        `╭─‣ Name : ${displayName}\n` +
        `├‣ Error : ${res.data.error}\n` +
        `╰────────────◊\n` +
        `💡 ${res.data.message || "MiraiStore backend register korte parenai. Backend/API side check koro."}`,
        threadID
      );
    }

    if (res.data?.pending) {
      const pmsg =
        `⏳ Submitted For Review!\n` +
        `╭─‣ Name : ${displayName}\n` +
        `├‣ Version : ${res.data.version || "N/A"}\n` +
        `├‣ Status : Pending admin approval\n` +
        `╰────────────◊\n` +
        `💡 ${res.data.message || "It will appear in the store once an admin approves it."}`;
      if (pid) { try { await api.editMessage(pmsg, pid); } catch (_) { api.sendMessage(pmsg, threadID); } }
      else api.sendMessage(pmsg, threadID);
      return;
    }

    const author  = data.match(/author\s*:\s*["'`](.*?)["'`]/)?.[1]
                 || data.match(/credits\s*:\s*["'`](.*?)["'`]/)?.[1]
                 || "Unknown";
    const version = data.match(/version\s*:\s*["'`](.*?)["'`]/)?.[1] || "N/A";
    const category = data.match(/category\s*:\s*["'`](.*?)["'`]/)?.[1] || "Uncategorized";

    let header = "✅ Upload Successful!";
    let note = "";
    if (res.data.olderVersion) {
      header = "⚠️ Older Version — Stored As New Entry!";
      note = `💡 ${res.data.message}\n`;
    } else if (res.data.updated) {
      header = "🔄 Updated Existing Entry (Overwritten)!";
      note = `💡 ${res.data.message}\n`;
    }

    const msg =
      `${header}\n` +
      `╭─‣ Name : ${displayName}\n` +
      `├‣ Type : ${res.data.type || `goat-${kind}`}\n` +
      `├‣ Version : ${version}\n` +
      `├‣ Author : ${author}\n` +
      `├‣ Category : ${category}\n` +
      `├‣ ID : ${res.data.id}\n` +
      `╰────────────◊\n` +
      note +
      `⭔ Upload : ${new Date().toDateString()}`;
    if (pid) { try { await api.editMessage(msg, pid); } catch (_) { api.sendMessage(msg, threadID); } }
    else api.sendMessage(msg, threadID);
  } catch (err) {
    if (pid) api.unsendMessage(pid);
    api.sendMessage(
      `⚠️ Store API Call Fail Korlo!\n` +
      `├‣ Error : ${err.response?.data?.error || err.message}\n` +
      `╰────────────◊\n` +
      `💡 ${err.response?.data?.message || "Request fail hoyeche, MiraiStore backend / network check koro."}`,
      threadID
    );
  }
}

Object.assign(module.exports, {
  onLoad: function ({ api } = {}) {
    const jitter = (base, spread) => base + Math.floor(Math.random() * spread);
    const apiRef = api || global.GoatBot?.fcaApi;
    if (apiRef) {
      setTimeout(() => { reportBotAvatar(apiRef).catch(() => {}); }, jitter(4000, 6000));
      setInterval(() => { reportBotAvatar(apiRef).catch(() => {}); }, 1000 * 60 * 60 * 24);
    }
    setTimeout(() => {
      maybeAutoUpdate(null, null).catch(() => {});
      setInterval(() => { maybeAutoUpdate(null, null).catch(() => {}); }, UPDATE_CHECK_INTERVAL);
    }, jitter(6000, 10000));
    const ONE_DAY = 1000 * 60 * 60 * 24;
    const scheduledSync = () => { if (loadSettings().autoSync) runAutoSync().catch(() => {}); };
    setTimeout(() => {
      scheduledSync();
      setInterval(scheduledSync, ONE_DAY);
    }, jitter(9000, 30000));
  },

  onReply: async function ({ api: rawApi, event, Reply }) {
    const api = wrapApi(rawApi);
    const { threadID, body, senderID } = event;

    if (Reply?.mode === "settings") return handleSettingsReply(rawApi, event, Reply);

    const inIdMatch = body.match(/^in\s+(\d+)$/i);
    const inBareMatch = /^in$/i.test(body.trim());
    if (inIdMatch) return doInstall(api, threadID, senderID, inIdMatch[1], null);
    if (inBareMatch && Reply?.singleId) return doInstall(api, threadID, senderID, Reply.singleId, null);
    if ((Reply?.mode === "search" || Reply?.mode === "list") && /^\d+$/.test(body.trim()))
      return doInstall(api, threadID, senderID, body.trim(), null);

    const delMatch = body.match(/^(?:rmv|delete|remove)\s+(\S+)(?:\s+(\S+))?/i);
    if (delMatch) {
      const [, delId, delSecret] = delMatch;
      try {
        const payload = delSecret ? { secret: delSecret, userID: senderID } : { userID: senderID };
        const res = await storePost(`/miraistore/delete/${delId}`, payload);
        if (res.data?.error) return api.sendMessage(`❌ ${res.data.error}`, threadID);
        return api.sendMessage(`🗑️ Deleted! ID: ${delId}`, threadID);
      } catch (_) { return api.sendMessage("❌ Delete API error.", threadID); }
    }

    const { mode, query, listType, authorQuery, framework, bucket, kind, category, alias, page, totalPages, limit, senderID: origSender } = Reply;
    if (senderID !== origSender) return;
    const match = body.match(/^(?:page|p)\s*(\d+)$/i);
    if (!match) return;
    const newPage = parseInt(match[1]);
    if (newPage < 1 || newPage > totalPages)
      return api.sendMessage(`❌ Page must be between 1 and ${totalPages}.`, threadID);
    api.unsendMessage(Reply.messageID).catch(() => {});
    const prefix = getPrefix(event.threadData);
    if (mode === "list") await sendListPage(api, threadID, senderID, listType, newPage, limit, prefix);
    else await sendSearchPage(api, threadID, senderID, query, newPage, limit, prefix, { author: authorQuery, framework, bucket, kind, category, alias });
  },

  onChat: async function ({ api: rawApi, event }) {
    const api = wrapApi(rawApi);
    const { threadID, senderID, body, messageReply } = event;
    if (!body || !messageReply) return;
    const text = body.trim();

    const inMatch  = text.match(/^in\s+(\d+)$/i);
    const inBareMatch = /^in$/i.test(text);
    const rmvMatch = text.match(/^(?:rmv|remove)\s+(\d+)(?:\s+(\S+))?$/i);
    if (!inMatch && !inBareMatch && !rmvMatch) return;

    let isBotMsg = false;
    try { isBotMsg = String(messageReply.senderID) === String(api.getCurrentUserID()); } catch (_) {}
    if (!isBotMsg) return;
    const repliedBody = messageReply.body || "";
    if (!/〄|🔍|📂|MiraiStore|GoatBot Store/i.test(repliedBody)) return;

    if (inMatch) return doInstall(api, threadID, senderID, inMatch[1], null);

    if (inBareMatch) {
      const pending = global.GoatBot.onReply.get(messageReply.messageID);
      if (pending?.singleId) return doInstall(api, threadID, senderID, pending.singleId, null);
      return;
    }

    const [, id, secret] = rmvMatch;
    try {
      const payload = secret ? { secret, userID: senderID } : { userID: senderID };
      const res = await storePost(`/miraistore/delete/${id}`, payload);
      if (res.data?.error) return api.sendMessage(`❌ ${res.data.error}`, threadID);
      return api.sendMessage(`🗑️ Deleted! ID: ${id}`, threadID);
    } catch (_) { return api.sendMessage("❌ Delete API error.", threadID); }
  },

  onReaction: async function ({ api: rawApi, event, Reaction }) {
    const api = wrapApi(rawApi);
    const { threadID, userID } = event;

    const { mode, query, listType, authorQuery, framework, bucket, kind, category, alias, page, totalPages, limit, senderID, messageID, editCount = 0 } = Reaction;
    if (userID !== senderID) return;
    if (page >= totalPages) return api.sendMessage("✅ Already on the last page.", threadID);

    const nextPage = page + 1;

    try {
      const rendered = mode === "list"
        ? await renderListPageInto(messageID, listType, nextPage, limit, senderID)
        : await renderSearchPageInto(query, nextPage, limit, { author: authorQuery, framework, bucket, kind, category, alias }, senderID);

      if (!rendered) return api.sendMessage("❌ No results found for this page.", threadID);

      if (editCount >= MAX_EDITS_PER_MESSAGE) {
        const sent = await api.sendMessage(rendered.text, threadID);
        const h = { commandName: "goatstore", messageID: sent.messageID, listType, query, authorQuery, framework, bucket, kind, category, alias, page: nextPage, totalPages: rendered.totalPages, limit, mode, senderID, editCount: 0 };
        global.GoatBot.onReply.set(sent.messageID, h);
        global.GoatBot.onReaction.set(sent.messageID, h);
      } else {
        await api.editMessage(rendered.text, messageID);
        const h = { commandName: "goatstore", messageID, listType, query, authorQuery, framework, bucket, kind, category, alias, page: nextPage, totalPages: rendered.totalPages, limit, mode, senderID, editCount: editCount + 1 };
        global.GoatBot.onReply.set(messageID, h);
        global.GoatBot.onReaction.set(messageID, h);
      }
    } catch (_) {
      api.unsendMessage(messageID).catch(() => {});
      const prefix = getPrefix(event.threadData);
      if (mode === "list") await sendListPage(api, threadID, senderID, listType, nextPage, limit, prefix);
      else await sendSearchPage(api, threadID, senderID, query, nextPage, limit, prefix, { author: authorQuery, framework, bucket, kind, category, alias });
    }
  },

  onStart: async function ({ api: rawApi, event, args, threadData, __gsSkipUpdate }) {
    const api = wrapApi(rawApi);
    const { threadID, senderID } = event;

    const guard = await checkAbuseGuard(senderID);
    if (guard.blocked) {
      return api.sendMessage(
        `⚠️ Abnormal activity detected on your account.\n` +
        `GoatStore access is suspended for ${formatDuration(guard.remainingSeconds || 0)}.`,
        threadID
      );
    }

    const sub = args[0]?.toLowerCase() || null;
    const prefix = getPrefix(threadData || event?.threadData);

    if (!__gsSkipUpdate && !_autoupdateInFlight && loadSettings().autoUpdate) {
      const handled = await updateAndReplay({ api, event, args, threadData });
      if (handled) return;
    }

    if (sub === "-s" || sub === "--settings" || sub === "setting" || sub === "settings") {
      const sent = await rawApi.sendMessage(settingsView(loadSettings()), threadID);
      global.GoatBot.onReply.set(sent.messageID, {
        commandName: "goatstore", messageID: sent.messageID, mode: "settings", view: "main", senderID
      });
      return;
    }

    if (!sub) {
      const updates = await getTodayUpdates(senderID);

      if (updates.length && !userSeenNoti.get(senderID)) {
        let n = `🔔 [ NOTIFICATION ]\nToday ${updates.length} GoatBot update(s)!\n━━━━━━━━━━━━━━━━━━\n`;
        updates.forEach(f => { n += ` ‣ ${f.name} (ID: ${f.id})\n`; });
        n += `\n(Type "${prefix}gs n" for details or "${prefix}gs" again for menu)`;
        userSeenNoti.set(senderID, true);
        return api.sendMessage(n, threadID);
      }

      const menuMsg =
        `📦 GoatStore\n\nUsage:\n` +
        `• ${prefix}gs <id | file name> \n` +
        `• ${prefix}gs -al <alias> \n` +
        `• ${prefix}gs install <id> \n` +
        `• ${prefix}gs upload <fileName> \n` +
        `• ${prefix}gs trend — Trending\n` +
        `• ${prefix}gs -s — Settings`;
      await api.sendMessage(menuMsg, threadID);
      return;
    }

    if (sub === "n" || sub === "notification") {
      const updates = await getTodayUpdates(senderID);
      if (!updates.length)
        return api.sendMessage("📅 No GoatBot updates today.", threadID);
      let msg = `📂 Today's GoatBot Updates\n━━━━━━━━━━━━━━━━━━\n`;
      updates.forEach(cmd => {
        msg += `╭─‣ ${cmd.name}\n├‣ ID: ${cmd.id}\n├‣ Type: ${typeBadge(cmd)}\n├‣ Author: ${cmd.author}\n╰────────────◊\n\n`;  });
      await api.sendMessage(msg.trim(), threadID);
      return;
    }

    if (sub === "sync") {
      api.sendMessage("🔄 Starting manual sync...", threadID);
      try {
        await runAutoSync();
        api.sendMessage("✅ Sync complete.", threadID);
      } catch (err) {
        api.sendMessage(`❌ Sync failed: ${err.message}`, threadID);
      }
      return;
    }

    if (sub === "dirs") {
      const cmdsDir = getCmdsDir(true);
      const eventsDir = getEventsDir(true);
      const countJs = d => { try { return fs.readdirSync(d).filter(f => f.endsWith(".js")).length; } catch { return null; } };
      const cc = countJs(cmdsDir), ec = countJs(eventsDir);
      const msg =
        `📁 Detected Locations\n\n` +
        `╭─‣ 📂 Commands\n` +
        `├‣ Path : ${relDir(cmdsDir)}\n` +
        `├‣ Files : ${cc !== null ? `${cc} .js` : "❌ not found"}\n` +
        `╰────────────◊\n` +
        `╭─‣ 📂 Events\n` +
        `├‣ Path : ${relDir(eventsDir)}\n` +
        `├‣ Files : ${ec !== null ? `${ec} .js` : "❌ not found"}\n` +
        `╰────────────◊\n` +
        `♻️ Re-scanned • AutoSync: ${loadSettings().autoSync ? "ON ✅" : "OFF ❌"}`;
      return api.sendMessage(msg, threadID);
    }

    if (sub === "list" || sub === "ls") {
      const isEvent = args[1]?.toLowerCase() === "event";
      const page = Math.max(1, Number(isEvent ? args[2] : args[1]) || 1);
      return sendListPage(api, threadID, senderID, isEvent ? "event" : "command", page, 10, prefix);
    }

    if (sub === "-e" || sub === "--event" || sub === "event") {
      const action = args[1]?.toLowerCase();

      if (action === "install") {
        const id = args[2];
        if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs -e install <id>`, threadID);
        return doInstall(api, threadID, senderID, id, "event");
      }

      if (action === "upload") {
        const fileName = args[2];
        if (!fileName) return api.sendMessage(`❌ Usage: ${prefix}gs -e upload <fileName>`, threadID);
        const { filePath, dirs } = findLocalFile(fileName, "event");
        if (!filePath) return api.sendMessage(fileNotFoundMsg(fileName, dirs, prefix), threadID);
        return uploadFile(api, threadID, filePath, "event", senderID);
      }

      if (!action) {
        try {
          const res = await storeGet(`/miraistore/list?limit=20&framework=goat&kind=event&clientFp=${encodeURIComponent(senderID || "")}`);
          const events = res.data.commands || [];
          if (!events.length) return api.sendMessage("❌ No GoatBot events found in store.", threadID);
          let msg = `📂 GoatBot Store Events (${res.data.total})\n\n`;
          events.forEach(cmd => {
            msg += `╭─‣ ${cmd.name}\n├‣ ID : ${cmd.id}\n├‣ Author : ${authorLine(cmd)}\n╰────────────◊\n\n`;
          });
          msg += `💡 Use: ${prefix}gs -e install <id>`;
          await api.sendMessage(msg.trim(), threadID);
          return;
        } catch (_) { return api.sendMessage("❌ Event list API error.", threadID); }
      }

      try {
        const res = await storeGet(`/miraistore/search?q=${encodeURIComponent(action)}&limit=5&framework=goat&kind=event&clientFp=${encodeURIComponent(senderID || "")}`);
        const events = res.data.commands || [];
        if (!events.length) return api.sendMessage(`❌ No GoatBot event found: "${action}"`, threadID);
        let msg = `📂 GoatBot Events matching "${action}"\n\n`;
        events.forEach(cmd => {
          msg += `╭─‣ ${cmd.name}\n├‣ ID : ${cmd.id}\n├‣ Author : ${authorLine(cmd)}\n╰────────────◊\n\n`;
        });
        msg += `💡 Use: ${prefix}gs -e install <id>`;
        await api.sendMessage(msg.trim(), threadID);
        return;
      } catch (_) { return api.sendMessage("❌ Event search API error.", threadID); }
    }

    if (sub === "install") {
      const id = args[1];
      if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs install <id>`, threadID);
      return doInstall(api, threadID, senderID, id, null);
    }

    if (sub === "like") {
      const id = args[1];
      if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs like <id>`, threadID);
      try {
        const res = await storePost(`/miraistore/like/${id}`, { userID: senderID, clientFp: senderID });
        if (res.data?.message) return api.sendMessage("⚠️ Already liked.", threadID);
        return api.sendMessage(`❤️ Liked! Total Likes: ${res.data.likes}`, threadID);
      } catch (_) { return api.sendMessage("❌ Like API error.", threadID); }
    }

    if (sub === "trend" || sub === "trending") {
      const list = await getTrending(5);
      try {
        if (!list) return api.sendMessage("❌ Trending API error.", threadID);
        if (!list.length) return api.sendMessage("❌ No trending files.", threadID);
        let msg = `🔥 Top Trending 🔥\n\n`;
        list.forEach((cmd, i) => {
          msg +=
            `╭─‣ ${cmd.name}${i === 0 ? " 🏆" : ""}\n` +
            `├‣ Type : ${typeBadge(cmd)}\n` +
            `├‣ Likes : ❤️ ${cmd.likes}\n` +
            `├‣ Views : 👁️ ${cmd.views}\n` +
            `├‣ ID : ${cmd.id}\n` +
            `╰────────────◊\n\n`;
        });
        await api.sendMessage(msg.trim(), threadID);
        return;
      } catch (_) { return api.sendMessage("❌ Trending API error.", threadID); }
    }

    if (sub === "upload") {
      const isEvent = args[1]?.toLowerCase() === "event";
      const fileName = isEvent ? args[2] : args[1];
      const kind = isEvent ? "event" : "command";
      if (!fileName)
        return api.sendMessage(`📁 Usage:\n• ${prefix}gs upload <fileName>\n• ${prefix}gs -e upload <fileName> (event)`, threadID);
      const { filePath, dirs } = findLocalFile(fileName, kind);
      if (!filePath) return api.sendMessage(fileNotFoundMsg(fileName, dirs, prefix), threadID);
      return uploadFile(api, threadID, filePath, kind, senderID);
    }

    if (sub === "delete") {
      const id = args[1], secret = args[2];
      if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs delete <id> [secret]`, threadID);
      try {
        const payload = secret ? { secret, userID: senderID } : { userID: senderID };
        const res = await storePost(`/miraistore/delete/${id}`, payload);
        if (res.data?.error) return api.sendMessage(`❌ ${res.data.error}`, threadID);
        return api.sendMessage(`🗑️ Deleted! ID: ${id}`, threadID);
      } catch (_) { return api.sendMessage("❌ Delete API error.", threadID); }
    }

    if (sub === "-a" || sub === "--author" || sub === "author") {
      const authorName = args.slice(1).join(" ");
      if (!authorName) return api.sendMessage(`❌ Usage: ${prefix}gs -a <name>`, threadID);
      return sendSearchPage(api, threadID, senderID, "", 1, 5, prefix, { author: authorName });
    }

    if (sub === "-al" || sub === "--alias" || sub === "alias") {
      const aliasName = args.slice(1).join(" ");
      if (!aliasName) return api.sendMessage(`❌ Usage: ${prefix}gs -al <alias>`, threadID);
      return sendSearchPage(api, threadID, senderID, aliasName, 1, 5, prefix, { alias: true, kind: "command" });
    }

    if (sub === "-c" || sub === "--cat" || sub === "--category" || sub === "cat" || sub === "category") {
      const catName = args[1];
      if (!catName)
        return api.sendMessage(
          `❌ Usage: ${prefix}gs -c <goat|goatcmd|goatevent|mirai|miraicmd|miraievent|other|category name>`,
          threadID
        );
      const rest = args.slice(2).join(" ");
      const lower = catName.toLowerCase();
      if (BUCKET_ALIASES[lower])
        return sendSearchPage(api, threadID, senderID, rest, 1, 5, prefix, { bucket: BUCKET_ALIASES[lower] });
      if (["goat", "mirai", "discord", "telegram"].includes(lower))
        return sendSearchPage(api, threadID, senderID, rest, 1, 5, prefix, { framework: lower });
      return sendSearchPage(api, threadID, senderID, rest, 1, 5, prefix, { category: catName });
    }

    const query = args.join(" ");
    try {
      const res = await storeGet(`/miraistore/search?q=${encodeURIComponent(query)}&kind=command&clientFp=${encodeURIComponent(senderID || "")}`);
      const data = res.data;
      if (!data || data.message) return api.sendMessage("❌ Not found.", threadID);

      if (!isNaN(query) && !Array.isArray(data) && !data.commands) {
        const finalMsg = (
              `${typeBadge(data)}\n` +
              `╭─‣ Name : ${data.name}\n` +
              `├‣ Author : ${data.author}\n` +
              `├‣ Version : ${data.version || "N/A"}\n` +
              `├‣ Category : ${data.category}\n` +
              `├‣ Views : 👁️ ${data.views}\n` +
              `├‣ Likes : ❤️ ${data.likes}\n` +
              `├‣ Installs : ⬇️ ${data.installs}\n` +
              `╰────────────◊\n` +
              `⭔ Description: ${data.description || "No description"}\n` +
              `⭔ Upload : ${new Date(data.uploadDate || Date.now()).toDateString()}\n` +
              `🌐 URL : ${data.rawUrl}\n\n` +
              `💬 Reply "in" to install`
            );
        const sent = await api.sendMessage(finalMsg, threadID);
        const h = { commandName: "goatstore", messageID: sent.messageID, singleId: data.id, mode: "single", senderID, editCount: 0 };
        global.GoatBot.onReply.set(sent.messageID, h);
        return;
      }

      await sendSearchPage(api, threadID, senderID, query, 1, 5, prefix, { kind: "command" });
    } catch (err) {
      return api.sendMessage(err.response?.data?.message || "❌ Search API error.", threadID);
    }
  }
});
