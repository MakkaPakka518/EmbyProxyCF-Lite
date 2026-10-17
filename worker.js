// ==========================================
// 基础配置区 (系统初始终极账号密码)
// ==========================================
// 注意：在线修改密码后，下方这个初始账号密码依然永久有效！防遗忘！
// 面板固定挂在域名根路径：https://你的域名/ 就是面板，无需配置访问路径
const CURRENT_VERSION = "lite-1.0.3";   // 版本号 (显示在面板页脚)
const ADMIN_USER = "账号";       // 初始面板账号 (支持字母/数字/常见特殊符号)
const ADMIN_PASS = "密码";     // 初始面板密码 (支持字母/数字/常见特殊符号)

// 部署自检：防止把占位符直接上线导致面板不可用
function configReady() {
    // 允许所有 ASCII 可打印字符（字母/数字/常见特殊符号如 . _ - @ ! # 等），长度 1-64
    const okUser = ADMIN_USER && ADMIN_USER !== '账号' && /^[\x21-\x7E]{1,64}$/.test(ADMIN_USER);
    const okPass = ADMIN_PASS && ADMIN_PASS !== '密码' && /^[\x21-\x7E]{1,64}$/.test(ADMIN_PASS);
    return okUser && okPass;
}

// B3: servers 配置内存缓存 (30s)，减少每个代理请求的 KV 读取延迟
let serversCache = null;
let serversCacheTs = 0;
const SERVERS_CACHE_TTL = 30000;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (!env.EMBY_KV) {
            return new Response("系统错误: 未绑定 KV 命名空间 EMBY_KV", { status: 500, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
        }

        // 部署自检：配置仍是占位符时给出明确提示，避免面板不可用
        if (!configReady()) {
            return new Response("部署配置未完成：请先修改 worker.js 顶部的 ADMIN_USER / ADMIN_PASS（去掉占位符）", { status: 500, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
        }

        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Max-Age": "86400",
                },
            });
        }

        // 面板直接挂域名根路径：/ 与 /api/* 进面板，其余路径走节点代理
        const nPath = url.pathname.replace(/\/+$/, '') || '/';
        if (nPath === '/' || nPath.startsWith('/api')) {
            return await handleAdmin(request, env, url);
        }

        // ==========================================
        // 核心功能辅助函数
        // ==========================================
        function isStaticPath(pathname) {
            return /\.(jpg|jpeg|gif|png|svg|ico|webp|js|css|woff2?|ttf|otf|map|webmanifest|srt|ass|vtt|sub)$/i.test(pathname)
                || /(\/Images\/|\/Icons\/|\/Branding\/|\/emby\/covers\/|\/img\/)/i.test(pathname);
        }

        function hasAuthLikeState(headers, targetUrl) {
            const authQueryKeys = ['api_key', 'x-emby-token', 'x-mediabrowser-token', 'access_token', 'token'];
            const hasAuthQuery = Array.from(targetUrl.searchParams.keys()).some(key => authQueryKeys.includes(key.toLowerCase()));
            return headers.has("Authorization") || headers.has("X-Emby-Token") || headers.has("X-MediaBrowser-Token") || headers.has("X-Emby-Authorization") || headers.has("Cookie") || hasAuthQuery;
        }

        function stripPanelCookie(headers) {
            const cookie = headers.get("Cookie");
            if (!cookie) return;
            const keptCookies = cookie.split(";").map(item => item.trim()).filter(item => item && !item.toLowerCase().startsWith("admin_token="));
            if (keptCookies.length > 0) headers.set("Cookie", keptCookies.join("; "));
            else headers.delete("Cookie");
        }

        function rewriteSetCookieForProxy(headers) {
            const getSetCookie = headers.getSetCookie ? headers.getSetCookie.bind(headers) : null;
            const rawSetCookie = headers.get("Set-Cookie");
            const cookies = getSetCookie ? getSetCookie() : (rawSetCookie ? rawSetCookie.split(/,(?=\s*[^;,]+=)/g) : []);
            if (cookies.length === 0) return;
            headers.delete("Set-Cookie");
            for (const cookie of cookies) headers.append("Set-Cookie", cookie.replace(/;\s*Domain=[^;]*/ig, ""));
        }

        function getTargetOrigins(targets) {
            const origins = [];
            for (const target of targets) {
                try {
                    const parsed = new URL(target);
                    const origin = parsed.origin;
                    const alternateOrigin = (parsed.protocol === 'https:' ? 'http:' : 'https:') + '//' + parsed.host;
                    if (!origins.includes(origin)) origins.push(origin);
                    if (!origins.includes(alternateOrigin)) origins.push(alternateOrigin);
                } catch (e) { }
            }
            return origins;
        }

        function rewriteSourceUrlString(value, targetOrigins, proxyOrigin, safePrefix) {
            let rewritten = value;
            const proxyPrefix = proxyOrigin + safePrefix + '/';
            for (const origin of targetOrigins) {
                let result = '';
                let cursor = 0;
                let index = rewritten.indexOf(origin);
                while (index !== -1) {
                    const alreadyProxied = rewritten.substring(Math.max(0, index - proxyPrefix.length), index) === proxyPrefix;
                    result += rewritten.substring(cursor, index);
                    result += alreadyProxied ? origin : proxyPrefix + origin;
                    cursor = index + origin.length;
                    index = rewritten.indexOf(origin, cursor);
                }
                if (cursor > 0) {
                    result += rewritten.substring(cursor);
                    rewritten = result;
                }
            }
            const relativeImagePattern = /(^|["'\s(])((?:\/img\/|\/emby\/Items\/[^"'\s)]+\/Images\/|\/Items\/[^"'\s)]+\/Images\/)[^"'\s)]*)/ig;
            rewritten = rewritten.replace(relativeImagePattern, (match, prefix, path) => {
                if (safePrefix && path.startsWith(safePrefix + '/')) return match;
                return prefix + proxyOrigin + safePrefix + path;
            });
            return rewritten;
        }

        function rewriteSourceUrlsInJson(value, targetOrigins, proxyOrigin, safePrefix) {
            if (typeof value === 'string') return rewriteSourceUrlString(value, targetOrigins, proxyOrigin, safePrefix);
            if (Array.isArray(value)) {
                let changed = false;
                const next = value.map(item => {
                    const rewritten = rewriteSourceUrlsInJson(item, targetOrigins, proxyOrigin, safePrefix);
                    if (rewritten !== item) changed = true;
                    return rewritten;
                });
                return changed ? next : value;
            }
            if (value && typeof value === 'object') {
                let changed = false;
                const next = {};
                for (const key of Object.keys(value)) {
                    const rewritten = rewriteSourceUrlsInJson(value[key], targetOrigins, proxyOrigin, safePrefix);
                    if (rewritten !== value[key]) changed = true;
                    next[key] = rewritten;
                }
                return changed ? next : value;
            }
            return value;
        }

        function dropBodyIntegrityHeaders(headers) {
            headers.delete("Content-Length");
            headers.delete("Content-Encoding");
            headers.delete("ETag");
        }

        function hasJsonRewriteCandidate(text, targetOrigins) {
            return targetOrigins.some(origin => text.includes(origin))
                || /(^|["'\s(])(?:\/img\/|\/emby\/Items\/[^"'\s)]+\/Images\/|\/Items\/[^"'\s)]+\/Images\/)/i.test(text);
        }

        function rewriteRedirectLocation(location, targetUrl, targetOrigins, proxyOrigin, safePrefix) {
            if (!location) return location;
            if (location.startsWith('//')) {
                try {
                    const protocol = targetUrl ? targetUrl.protocol : new URL(targetOrigins[0]).protocol;
                    location = protocol + location;
                } catch (e) { }
            }
            if (location.startsWith('/')) {
                if (safePrefix && location.startsWith(safePrefix + '/')) return proxyOrigin + location;
                if (!safePrefix && targetUrl) return `${proxyOrigin}/${encodeURIComponent(new URL(location, targetUrl.origin).href)}`;
                return proxyOrigin + safePrefix + location;
            }
            try {
                const parsed = new URL(location);
                if (targetOrigins.includes(parsed.origin)) {
                    if (!safePrefix) return `${proxyOrigin}/${encodeURIComponent(location)}`;
                    return proxyOrigin + safePrefix + parsed.pathname + parsed.search + parsed.hash;
                }
            } catch (e) { }
            if (/^https?:\/\//i.test(location)) return `${proxyOrigin}${safePrefix}/${encodeURIComponent(location)}`;
            return location;
        }

        // ==========================================
        // 代理核心：支持故障转移、强力模式、图片缓存
        // ==========================================
        const decodedPath = decodeURIComponent(url.pathname);
        const pathParts = decodedPath.split('/');

        if (pathParts.length < 2 || !pathParts[1]) {
            return new Response("无效的访问格式。请通过根路径 / 登录面板获取正确的客户端地址。", { status: 400 });
        }

        const serverId = pathParts[1];
        const restPath = '/' + pathParts.slice(2).join('/');
        let serversStr;
        if (serversCache && Date.now() - serversCacheTs < SERVERS_CACHE_TTL) {
            serversStr = serversCache;
        } else {
            serversStr = await env.EMBY_KV.get('servers');
            serversCache = serversStr;
            serversCacheTs = Date.now();
        }
        let servers = serversStr ? JSON.parse(serversStr) : [];

        let serverConfig;
        if (Array.isArray(servers)) {
            serverConfig = servers.find(s => s.path === serverId);
        } else {
            serverConfig = servers[serverId];
        }

        if (!serverConfig) return new Response(`未找到标识为 '${serverId}' 的节点。`, { status: 404 });

        const backendUrlStr = typeof serverConfig === 'string' ? serverConfig : serverConfig.url;
        const backendUrls = backendUrlStr.split(',').map(u => u.trim().replace(/\/$/, "")).filter(Boolean);
        const proxyMode = typeof serverConfig === 'object' ? (serverConfig.mode || 'normal') : 'normal';
        const enableCache = typeof serverConfig === 'object' ? (serverConfig.cacheImages || false) : false;

        const isStaticOrImage = isStaticPath(url.pathname);
        let targetOrigins = getTargetOrigins(backendUrls);

        // A2: Emby / Jellyfin 路径归一化——源站挂在 /emby 子路径、或客户端固定拼 /emby 时双向回退
        function isLikelyMediaServerPath(pathname) {
            return /^\/(?:Items|Videos|Audio|Sessions|Users|System|Library|LiveTv|Shows|Movies|Artists|Albums|Playlists|Channels|Packages|Devices|Socket|socket|web|emby|Images|Branding|Environment|DisplayPreferences|Trailers|Collections|Genres|Persons|Studios|Years)(?:\/|$)/i.test(pathname);
        }
        function buildUpstreamCandidates(targetBase, remainingPath, search) {
            const candidates = [];
            const pushUnique = (value) => { if (value && !candidates.includes(value)) candidates.push(value); };
            const primary = targetBase + remainingPath + search;
            pushUnique(primary);
            try {
                const parsed = new URL(targetBase);
                const basePath = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
                const requestPath = remainingPath || '/';
                const hasNoBasePath = (basePath === '/');
                const requestAlreadyHasEmbyPrefix = /^\/emby(?:\/|$)/i.test(requestPath);
                if (hasNoBasePath && !requestAlreadyHasEmbyPrefix && isLikelyMediaServerPath(requestPath)) {
                    pushUnique(`${parsed.origin}/emby${requestPath}${search}`);
                }
                if (hasNoBasePath && requestAlreadyHasEmbyPrefix && isLikelyMediaServerPath(requestPath)) {
                    const strippedRequestPath = requestPath.replace(/^\/emby(?=\/|$)/i, '') || '/';
                    pushUnique(`${parsed.origin}${strippedRequestPath}${search}`);
                }
                // 绝对 URL 透传场景：/节点/https://host/Items/... 缺 /emby 时补一个候选
                if (/^https?:\/\//i.test(requestPath)) {
                    try {
                        const absParsed = new URL(requestPath.replace(/^\/+/, ''));
                        if (isLikelyMediaServerPath(absParsed.pathname) && !/^\/emby(?:\/|$)/i.test(absParsed.pathname)) {
                            pushUnique(`${absParsed.origin}/emby${absParsed.pathname}${absParsed.search}`);
                        }
                    } catch (e) { }
                }
            } catch (e) { }
            return candidates;
        }

        let finalResponse;
        let lastErr;
        let finalTargetUrl = null;

        for (let i = 0; i < backendUrls.length; i++) {
            let targetUrlStrs;
            if (restPath.startsWith('/http://') || restPath.startsWith('/https://')) {
                targetUrlStrs = [restPath.substring(1) + url.search];
            } else {
                targetUrlStrs = buildUpstreamCandidates(backendUrls[i], restPath, url.search);
            }

            for (let ci = 0; ci < targetUrlStrs.length; ci++) {
                const targetUrl = new URL(targetUrlStrs[ci]);
                const newHeaders = new Headers(request.headers);

                newHeaders.set("Host", targetUrl.host);
                stripPanelCookie(newHeaders); // 过滤面板专属 Cookie 避免带给源站

                const realIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || (request.headers.get("x-forwarded-for") || "").split(',')[0].trim();
                newHeaders.delete("cf-connecting-ip");
                newHeaders.delete("cf-ipcountry");
                newHeaders.delete("cf-ray");
                newHeaders.delete("cf-visitor");
                newHeaders.delete("x-forwarded-for");
                newHeaders.delete("x-real-ip");

                newHeaders.set("X-Forwarded-Proto", url.protocol.replace(':', ''));
                newHeaders.set("X-Forwarded-Host", url.host);

                if (proxyMode === 'strict') {
                    if (realIp) { newHeaders.set("X-Real-IP", realIp); newHeaders.set("X-Forwarded-For", realIp); }
                    newHeaders.set("Origin", targetUrl.origin);
                    newHeaders.set("Referer", targetUrl.origin + "/");
                } else {
                    const origin = newHeaders.get("Origin");
                    if (origin && origin === url.origin) newHeaders.set("Origin", targetUrl.origin);
                    const referer = newHeaders.get("Referer");
                    if (referer && referer.startsWith(url.origin)) newHeaders.set("Referer", referer.replace(url.origin, targetUrl.origin));
                }

                const authLikeState = hasAuthLikeState(newHeaders, targetUrl);

                let fetchOpts = {
                    method: request.method,
                    headers: newHeaders,
                    body: (request.method !== 'GET' && request.method !== 'HEAD') ?
                        await request.clone().arrayBuffer() : null,
                    redirect: isStaticOrImage ? 'follow' : 'manual'
                };

                // C1: cf 缓存选项放到 fetch() 第二参数（经 new Request 构造会丢失该选项）
                let cfOpts = null;
                if (enableCache && isStaticOrImage && request.method === 'GET' && !authLikeState) {
                    cfOpts = { cacheTtl: 2592000, cacheEverything: true };
                }

                const modifiedRequest = new Request(targetUrl, fetchOpts);
                try {
                    finalResponse = await fetch(modifiedRequest, cfOpts || undefined);
                    if (finalResponse.status >= 500) { lastErr = new Error('源站返回 HTTP ' + finalResponse.status); finalResponse = null; continue; }
                    finalTargetUrl = targetUrl;
                    break;
                } catch (err) {
                    lastErr = err;
                    continue;
                }
            }
            if (finalResponse) break;
        }

        if (!finalResponse) return new Response("节点故障, 错误: " + (lastErr ? lastErr.message : 'Unknown'), { status: 502 });

        try {
            const responseHeaders = new Headers(finalResponse.headers);
            rewriteSetCookieForProxy(responseHeaders);

            const safePrefix = `/${serverId}`;
            const proxyOrigin = url.origin;

            // 1. 拦截并改写 301/302 Redirect
            if ([301, 302, 303, 307, 308].includes(finalResponse.status)) {
                const location = responseHeaders.get('Location');
                const rewrittenLocation = rewriteRedirectLocation(location, finalTargetUrl, targetOrigins, proxyOrigin, safePrefix);
                if (rewrittenLocation !== location) {
                    responseHeaders.set('Location', rewrittenLocation);
                }
            }

            // 2. 补上正确的浏览器端缓存响应头
            const contentType = responseHeaders.get("content-type") || "";
            const canCacheStaticRes = isStaticOrImage
                && enableCache
                && finalResponse.status === 200
                && (
                    contentType.startsWith("image/")
                    || contentType.includes("javascript")
                    || contentType.includes("css")
                    || contentType.includes("font")
                    || contentType.includes("manifest")
                );
            if (canCacheStaticRes && !responseHeaders.has("Cache-Control")) {
                responseHeaders.set('Cache-Control', 'public, max-age=2592000, immutable');
            } else if (!isStaticOrImage) {
                responseHeaders.set('Cache-Control', 'no-store');
            }

            responseHeaders.set('Access-Control-Allow-Origin', '*');

            // 3. PlaybackInfo 播放流 URL 重写
            if (finalResponse.status === 200 && responseHeaders.get("content-type")?.includes("json") && url.pathname.toLowerCase().includes("playbackinfo")) {
                try {
                    let clonedRes = finalResponse.clone();
                    let data = await clonedRes.json();
                    let modified = false;
                    if (data && data.MediaSources) {
                        data.MediaSources.forEach(source => {
                            ['DirectStreamUrl', 'TranscodingUrl'].forEach(key => {
                                if (source[key] && (source[key].startsWith('http://') || source[key].startsWith('https://'))) {
                                    source[key] = proxyOrigin + safePrefix + '/' + source[key];
                                    modified = true;
                                }
                            });
                        });
                    }
                    if (modified) {
                        dropBodyIntegrityHeaders(responseHeaders);
                        return new Response(JSON.stringify(data), { status: finalResponse.status, headers: responseHeaders });
                    }
                } catch (e) { }
            }

            // 4. 通用 JSON URL 重写
            if (finalResponse.status === 200 && responseHeaders.get("content-type")?.includes("json")) {
                try {
                    let clonedRes = finalResponse.clone();
                    let text = await clonedRes.text();
                    if (hasJsonRewriteCandidate(text, targetOrigins)) {
                        let data = JSON.parse(text);
                        let rewritten = rewriteSourceUrlsInJson(data, targetOrigins, proxyOrigin, safePrefix);
                        if (rewritten !== data) {
                            dropBodyIntegrityHeaders(responseHeaders);
                            return new Response(JSON.stringify(rewritten), { status: finalResponse.status, headers: responseHeaders });
                        }
                    }
                } catch (e) {
                    console.log("JSON Rewrite Error:", e.message);
                }
            }

            // 5. M3U8 切片链接重写 (A1: 绝对 URL / 协议相对 / 根相对三种分片形态全覆盖)
            if (finalResponse.status === 200 && url.pathname.toLowerCase().endsWith('.m3u8')) {
                try {
                    let clonedRes = finalResponse.clone();
                    let text = await clonedRes.text();
                    if (text.includes('http://') || text.includes('https://') || /^\s*\//m.test(text)) {
                        // 绝对 URL 分片：代理到 /密钥/节点/源站URL
                        let modifiedText = text.replace(/(https?:\/\/[^\s]+)/g, proxyOrigin + safePrefix + '/$1');
                        // 协议相对分片（//host/path）：补 https 协议再代理
                        modifiedText = modifiedText.replace(/^(?!\s*#)(\s*)\/\/([^\s]+)$/gm, (m, sp, p) => sp + proxyOrigin + safePrefix + '/https://' + p);
                        // 根相对分片（/path）：补源站根 + 代理前缀，避免浏览器解析到不带节点前缀的根路径导致 404
                        const firstOrigin = (backendUrls[0] || '').replace(/\/+$/, '');
                        if (firstOrigin) {
                            modifiedText = modifiedText.replace(/^(?!\s*#)(\s*)\/([^\s]+)$/gm, (m, sp, p) => sp + proxyOrigin + safePrefix + '/' + firstOrigin + '/' + p);
                        }
                        dropBodyIntegrityHeaders(responseHeaders);
                        return new Response(modifiedText, { status: finalResponse.status, statusText: finalResponse.statusText, headers: responseHeaders });
                    }
                } catch (e) { }
            }

            return new Response(finalResponse.body, { status: finalResponse.status, headers: responseHeaders });
        } catch (err) {
            return new Response("响应处理错误", { status: 502 });
        }
    }
};

// ==========================================
// 后台管理面板逻辑 ("双轨制"密码共存)
// ==========================================
async function handleAdmin(request, env, url) {
    const nPath = url.pathname.replace(/\/+$/, '') || '/';
    let customUser = null, customPass = null;
    try {
        const storedCreds = await env.EMBY_KV.get('admin_credentials');
        if (storedCreds) {
            const creds = JSON.parse(storedCreds);
            if (creds.user && creds.pass) { customUser = creds.user; customPass = creds.pass; }
        }
    } catch (e) { }

    const hardcodedToken = btoa(`${ADMIN_USER}:${ADMIN_PASS}`);
    const customToken = (customUser && customPass) ? btoa(`${customUser}:${customPass}`) : null;
    const cookieHeader = request.headers.get('Cookie') || '';
    const isLoggedIn = cookieHeader.includes(`admin_token=${hardcodedToken}`) || (customToken && cookieHeader.includes(`admin_token=${customToken}`));

    if (nPath.startsWith('/api')) {
        if (nPath === '/api/login' && request.method === 'POST') {
            const body = await request.json();
            const isHardcodedMatch = (body.username === ADMIN_USER && body.password === ADMIN_PASS);
            const isCustomMatch = (customUser && customPass && body.username === customUser && body.password === customPass);
            if (isHardcodedMatch || isCustomMatch) {
                const tokenToSet = isCustomMatch ? customToken : hardcodedToken;
                return new Response(JSON.stringify({ success: true }), {
                    status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': `admin_token=${tokenToSet}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly` }
                });
            }
            return new Response(JSON.stringify({ success: false }), { status: 401 });
        }

        if (!isLoggedIn) return new Response('Unauthorized', { status: 401 });

        if (nPath === '/api/password' && request.method === 'POST') {
            const body = await request.json();
            await env.EMBY_KV.put('admin_credentials', JSON.stringify({ user: body.newUser, pass: body.newPass }));
            return new Response('OK', { headers: { 'Set-Cookie': `admin_token=${btoa(`${body.newUser}:${body.newPass}`)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly` } });
        }

        if (nPath === '/api') {
            if (request.method === 'GET') {
                return new Response(await env.EMBY_KV.get('servers') || '[]', { headers: { 'Content-Type': 'application/json' } });
            } else if (request.method === 'POST') {
                await env.EMBY_KV.put('servers', await request.text());
                // B3: 配置变更后失效内存缓存
                serversCache = null; serversCacheTs = 0;
                return new Response('OK');
            }
        }

        if (nPath === '/api/ping') {
            let target = url.searchParams.get('target');
            if (!target) return new Response('Miss', { status: 400 });
            target = target.split(',')[0].trim();
            const startTime = Date.now();
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 4000);
                await fetch(target, { method: 'GET', signal: controller.signal, headers: { 'User-Agent': 'Cloudflare-Ping' } });
                clearTimeout(timeout);
                return new Response((Date.now() - startTime).toString(), { status: 200 });
            } catch (e) {
                return new Response('Timeout', { status: 504 });
            }
        }
    }

    return new Response(ADMIN_HTML.replace('{{IS_LOGGED_IN}}', isLoggedIn ? 'true' : 'false'), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ==========================================
// 前端代码 (Apple 风格设置与卡片 UI)
// ==========================================
const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title> Emby Nodes</title>
    <style>
        :root[data-theme="light"] { 
            --bg-color: #F2F2F7; 
            --card-bg: rgba(255, 255, 255, 0.7); 
            --glass-bg: rgba(255, 255, 255, 0.65);
            --border-color: rgba(60, 60, 67, 0.15); 
            --text-main: #1C1C1E; 
            --text-muted: #8A8A8E; 
            --primary: #007AFF; 
            --danger: #FF3B30; 
            --success: #34C759; 
            --warning: #FF9500; 
            --input-bg: rgba(118, 118, 128, 0.12); 
            --shadow: 0 8px 30px rgba(0,0,0,0.04); 
            --dock-hover: rgba(0,0,0,0.08);
            --settings-hover: rgba(0,0,0,0.04);
        }
        :root[data-theme="dark"] { 
            --bg-color: #000000; 
            --card-bg: rgba(28, 28, 30, 0.6); 
            --glass-bg: rgba(30, 30, 30, 0.65);
            --border-color: rgba(84, 84, 88, 0.3); 
            --text-main: #FFFFFF; 
            --text-muted: #EBEBF5; 
            --primary: #0A84FF; 
            --danger: #FF453A; 
            --success: #32D74B; 
            --warning: #FF9F0A; 
            --input-bg: rgba(118, 118, 128, 0.24); 
            --shadow: 0 8px 30px rgba(0,0,0,0.4); 
            --dock-hover: rgba(255,255,255,0.15);
            --settings-hover: rgba(255,255,255,0.08);
        }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-tap-highlight-color: transparent;}
        body { background: var(--bg-color); margin: 0; padding: 0; color: var(--text-main); transition: background-color 0.4s; overflow-x: hidden;}
        
        .container { max-width: 1200px; margin: 0 auto; min-height: 100vh; padding: 40px 20px 120px 20px; display: flex; flex-direction: column; }
        
        /* 登录界面 */
        #loginView { display: none; height: 100vh; align-items: center; justify-content: center; padding: 0; }
        .login-card { background: var(--card-bg); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); padding: 50px 40px; border-radius: 28px; box-shadow: var(--shadow); border: 1px solid var(--border-color); width: 100%; max-width: 380px; text-align: center; }
        .login-card h2 { margin-top: 0; margin-bottom: 30px; font-weight: 600; letter-spacing: -0.5px; }
        
        /* 悬浮搜索框 */
        #searchFloating { display: none; position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 100; width: 90%; max-width: 500px; background: var(--glass-bg); backdrop-filter: saturate(180%) blur(30px); -webkit-backdrop-filter: saturate(180%) blur(30px); padding: 12px 20px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); border: 1px solid var(--border-color); animation: slideDown 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        @keyframes slideDown { from { top: -50px; opacity: 0; } to { top: 20px; opacity: 1; } }
        #searchFloating input { width: 100%; border: none; background: transparent; color: var(--text-main); outline: none; font-size: 16px; }
        
        /* 输入框与按钮 */
        .input-wrapper { background: var(--input-bg); border-radius: 14px; transition: 0.3s; width: 100%; display: flex; align-items: center;}
        .input-wrapper input, .input-wrapper select { width: 100%; background: transparent; border: none; padding: 14px 16px; color: var(--text-main); outline: none; font-size: 15px; appearance: none; }
        .input-wrapper:focus-within { box-shadow: 0 0 0 2px var(--primary); background: var(--card-bg);}
        .input-wrapper.locked { opacity: 0.6; pointer-events: none; }
        select option { background: var(--bg-color); color: var(--text-main); }
        
        button { background: var(--primary); color: white; border: none; padding: 14px 20px; border-radius: 14px; cursor: pointer; font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 6px; justify-content: center; transition: 0.2s; box-shadow: 0 4px 14px rgba(0, 122, 255, 0.3);}
        button:active { transform: scale(0.96); }
        .btn-theme { background: var(--input-bg); color: var(--text-main); box-shadow: none; padding: 10px 16px; font-size: 14px; }
        .btn-edit { background: transparent; border: 1.5px solid var(--primary); color: var(--primary); padding: 8px 16px; box-shadow: none; border-radius: 10px; margin-right: 10px;}
        .btn-edit.active { background: var(--primary); color: white; box-shadow: 0 4px 14px rgba(0, 122, 255, 0.3); }
        .btn-danger { background: rgba(255, 59, 48, 0.1); border: none; color: var(--danger); padding: 10px 16px; box-shadow: none; border-radius: 10px; font-size: 14px;}
        
        /* 卡片网格 */
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 24px; align-content: start;}
        .card { background: var(--card-bg); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); border: 1px solid var(--border-color); border-radius: 24px; padding: 24px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow); transition: transform 0.3s, box-shadow 0.3s;}
        .card:hover { transform: translateY(-4px); box-shadow: 0 12px 40px rgba(0,0,0,0.1); }
        .card.dragging { opacity: 0.5; transform: scale(0.95); border: 2px dashed var(--primary); }
        
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;}
        .card-title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 22px; color: var(--primary); letter-spacing: -0.3px;}
        .drag-handle { cursor: grab; font-size: 16px; color: var(--text-muted); padding: 5px;}
        .info-row { display: flex; align-items: center; padding: 6px 0; font-size: 15px;}
        .info-row span { color: var(--text-muted); min-width: 75px; font-weight: 500;}
        .info-row strong { color: var(--text-main); font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1;}
        .icon-btn { cursor: pointer; color: var(--text-muted); padding: 8px; border-radius: 10px; display:flex; align-items:center; transition: 0.2s; flex-shrink: 0;}
        .icon-btn:hover { background: var(--input-bg); color: var(--text-main); }
        .icon-btn svg { width: 20px; height: 20px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
        
        .field-group { display: flex; flex-direction: column; gap: 8px; text-align: left; margin-bottom: 8px;}
        .field-group label { font-size: 13px; font-weight: 500; color: var(--text-muted); margin-left: 6px;}

        /* 系统设置模态框 (Apple 风格) */
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 1000; justify-content: center; align-items: center; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); opacity: 0; transition: opacity 0.3s;}
        .modal-overlay.show { opacity: 1; }
        .settings-panel { background: var(--card-bg); padding: 0 0 24px 0; border-radius: 28px; width: 90%; max-width: 400px; max-height: 85vh; overflow-y: auto; box-shadow: 0 20px 40px rgba(0,0,0,0.2); border: 1px solid var(--border-color); transform: scale(0.95); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); scrollbar-width: none;}
        .settings-panel::-webkit-scrollbar { display: none; }
        .modal-overlay.show .settings-panel { transform: scale(1); }
        
        .settings-header { position: sticky; top: 0; background: var(--glass-bg); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 10; border-bottom: 1px solid var(--border-color); border-radius: 28px 28px 0 0;}
        .settings-header h3 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;}
        
        .settings-section-title { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin: 24px 24px 8px 36px; letter-spacing: 0.5px;}
        .settings-group { background: var(--input-bg); border-radius: 16px; margin: 0 24px; overflow: hidden; }
        .settings-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; color: var(--text-main); font-size: 15px; font-weight: 500; border-bottom: 1px solid var(--border-color); cursor: pointer; transition: 0.2s;}
        .settings-item:last-child { border-bottom: none; }
        .settings-item:active { background: var(--settings-hover); }
        
        /* 底部 Dock 栏 */
        .dock-container { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 99; width: 95%; max-width: 320px; display: flex; justify-content: center;}
        .dock { display: flex; gap: 8px; padding: 12px 16px; background: var(--glass-bg); backdrop-filter: saturate(200%) blur(30px); -webkit-backdrop-filter: saturate(200%) blur(30px); border-radius: 32px; border: 1px solid var(--border-color); box-shadow: 0 10px 40px rgba(0,0,0,0.15); width: 100%; justify-content: space-around;}
        .dock-item { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 18px; color: var(--text-main); cursor: pointer; transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1); position: relative; flex-shrink: 0;}
        .dock-item:hover { background: var(--dock-hover); transform: translateY(-8px) scale(1.15); z-index: 2; }
        .dock-item:active { transform: translateY(-4px) scale(1.05); }
        .dock-item svg { width: 24px; height: 24px; stroke: currentColor; fill: none; stroke-width: 1.8; margin-bottom: 4px; }
        .dock-item span { font-size: 10px; font-weight: 500; opacity: 0.8; transition: 0.2s;}
        .dock-item:hover span { opacity: 1; }
        .dock-tooltip { position: absolute; top: -40px; background: rgba(0,0,0,0.8); color: white; padding: 6px 12px; border-radius: 10px; font-size: 12px; opacity: 0; pointer-events: none; transition: 0.2s; white-space: nowrap; font-weight: 500;}
        .dock-item:hover .dock-tooltip { opacity: 1; top: -45px; }

        .footer { margin-top: 40px; text-align: center; color: var(--text-muted); font-size: 13px; font-weight: 500;}
        
        /* 弹窗提示 */
        #toast { position: fixed; top: 40px; left: 50%; transform: translateX(-50%) translateY(-20px) scale(0.9); background: var(--glass-bg); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); color: var(--text-main); border: 1px solid var(--border-color); padding: 14px 28px; border-radius: 30px; font-weight: 600; box-shadow: 0 10px 30px rgba(0,0,0,0.1); opacity: 0; z-index: 9999; pointer-events: none; transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);}
        #toast.show { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }

        #appView { display: none; flex-direction: column; width: 100%; }

        @media screen and (max-width: 768px) {
            .grid { grid-template-columns: 1fr; }
            .dock { padding: 10px; gap: 4px;}
            .dock-item { width: 50px; height: 50px; }
            .dock-container { bottom: 16px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="loginView">
            <div class="login-card">
                <h2> Emby Nodes</h2>
                <form id="loginForm" onsubmit="handleLogin(event)" style="display: flex; flex-direction: column; gap: 16px;">
                    <div class="input-wrapper"><input type="text" id="username" required placeholder="管理员账号"></div>
                    <div class="input-wrapper"><input type="password" id="password" required placeholder="管理员密码"></div>
                    <button type="submit" id="loginBtn" style="margin-top: 10px;">解锁面板</button>
                </form>
            </div>
        </div>

        <div id="appView">
            <div id="searchFloating">
                <input type="text" id="searchInput" placeholder="🔍 搜索节点或域名..." oninput="filterCards()">
            </div>
            
            <div id="grid" class="grid"></div>
            <div class="footer">Made with <span style="color:var(--danger)">♥</span> by MakkaPakka · v${CURRENT_VERSION}</div>
            <input type="file" id="importFile" style="display:none" accept=".json" onchange="handleImport(event)">
        </div>
    </div>

    <div class="dock-container" id="dockContainer" style="display: none;">
        <div class="dock">
            <div class="dock-item" onclick="document.getElementById('appView').scrollIntoView({behavior: 'smooth'})">
                <div class="dock-tooltip">回到顶部</div>
                <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
                <span>首页</span>
            </div>
            <div class="dock-item" onclick="toggleSearch()">
                <div class="dock-tooltip">查找节点</div>
                <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <span>搜索</span>
            </div>
            <div class="dock-item" onclick="addCard(); document.getElementById('grid').scrollIntoView({behavior: 'smooth', block: 'start'})">
                <div class="dock-tooltip">创建新节点</div>
                <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>添加</span>
            </div>
            <div class="dock-item" onclick="openSettings()">
                <div class="dock-tooltip">系统设置</div>
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                <span>设置</span>
            </div>
        </div>
    </div>

    <div id="settingsModal" class="modal-overlay">
        <div class="settings-panel">
            <div class="settings-header">
                <h3>系统设置</h3>
                <div class="icon-btn" style="padding: 6px; background: var(--input-bg);" onclick="closeSettings()">
                    <svg viewBox="0 0 24 24" style="width: 18px; height: 18px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </div>
            </div>
            
            <div class="settings-section-title">外观与主题</div>
            <div class="settings-group">
                <div class="settings-item" onclick="toggleTheme()">
                    <span>🌓 深色 / 浅色模式</span>
                    <span id="themeStateText" style="color: var(--text-muted);">深色</span>
                </div>
            </div>

            <div class="settings-section-title">数据与备份</div>
            <div class="settings-group">
                <div class="settings-item" onclick="exportConfig()">
                    <span>📤 导出节点配置</span>
                    <svg viewBox="0 0 24 24" style="width: 16px; color: var(--text-muted);"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </div>
                <div class="settings-item" onclick="triggerImport()">
                    <span>📥 导入节点配置</span>
                    <svg viewBox="0 0 24 24" style="width: 16px; color: var(--text-muted);"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </div>
            </div>

            <div class="settings-section-title">安全中心 (更改密码)</div>
            <div class="settings-group" style="padding: 16px; display:flex; flex-direction:column; gap:12px;">
                <div class="input-wrapper"><input type="text" id="newAdminUser" placeholder="设置新账号" autocomplete="off"></div>
                <div class="input-wrapper"><input type="password" id="newAdminPass" placeholder="设置新密码" autocomplete="off"></div>
                <button style="width: 100%; margin-top: 4px;" onclick="changePassword()">确认修改</button>
            </div>
        </div>
    </div>
    
    <div id="toast">操作成功</div>

    <script>
        window.IS_LOGGED_IN = {{IS_LOGGED_IN}}; 
        let serverData = [];
        const originUrl = window.location.origin;
        // A4: 规范化面板路径，避免 /admin/ 尾斜杠导致 API 拼成 /admin//api
        const apiBase = '/api';

        const iconEyeOpen = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        const iconEyeClosed = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
        const iconCopy = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        const iconDrag = '<svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="16" y2="6"></line><line x1="8" y1="12" x2="16" y2="12"></line><line x1="8" y1="18" x2="16" y2="18"></line></svg>';
        const iconEdit = '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';

        function init() {
            initTheme();
            if (window.IS_LOGGED_IN) { 
                document.getElementById('appView').style.display = 'flex'; 
                document.getElementById('dockContainer').style.display = 'flex';
                loadData(); 
            } else { 
                document.getElementById('loginView').style.display = 'flex'; 
            }
        }

        async function handleLogin(e) {
            e.preventDefault(); 
            const btn = document.getElementById('loginBtn');
            btn.innerText = '正在解锁...';
            try {
                const res = await fetch(apiBase + '/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({username: document.getElementById('username').value, password: document.getElementById('password').value})
                });
                if (res.ok) { showToast('✅ 验证成功', 'var(--success)'); setTimeout(() => window.location.reload(), 500); } 
                else { showToast('❌ 账号或密码错误', 'var(--danger)'); btn.innerText = '解锁面板'; }
            } catch(err) { showToast('❌ 网络连接异常', 'var(--danger)'); btn.innerText = '解锁面板'; }
        }

        async function loadData() {
            try {
                const res = await fetch(apiBase);
                if (res.status === 401) return window.location.reload();
                const d = await res.json();
                serverData = (Array.isArray(d) ? d : Object.entries(d).map(([p, v]) => ({path: p, ...(typeof v === 'string' ? {url:v} : v)}))).map(o => ({
                    path: o.path||'', url: o.url||'', name: o.name||'', mode: o.mode||'normal', cacheImages: o.cacheImages||false, showEye: false, isEditing: false, latency: '测试延迟'
                }));
            } catch(e) { serverData = []; }
            render();
        }

        function initTheme() {
            const t = localStorage.getItem('emby_proxy_theme') || 'dark';
            document.documentElement.setAttribute('data-theme', t); 
            updateThemeText(t);
        }
        function toggleTheme() {
            const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', t); 
            localStorage.setItem('emby_proxy_theme', t); 
            updateThemeText(t);
        }
        function updateThemeText(t) { 
            const textEl = document.getElementById('themeStateText');
            if(textEl) textEl.innerText = t === 'dark' ? '深色' : '浅色';
        }
        
        function toggleSearch() {
            const sb = document.getElementById('searchFloating');
            if(sb.style.display === 'none' || !sb.style.display) {
                sb.style.display = 'block';
                document.getElementById('searchInput').focus();
            } else {
                sb.style.display = 'none';
                document.getElementById('searchInput').value = '';
                filterCards();
            }
        }

        let dragSrcIndex = null;
        window.dragStart = function(e, index) { dragSrcIndex = index; setTimeout(() => e.target.classList.add('dragging'), 0); }
        window.dragEnd = function(e) { e.target.classList.remove('dragging'); }
        window.dragOver = function(e) { e.preventDefault(); }
        window.drop = function(e, targetIndex) {
            e.preventDefault();
            if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
            serverData.splice(targetIndex, 0, serverData.splice(dragSrcIndex, 1)[0]);
            render(); saveData(false); showToast('🔄 节点顺序已保存');
        }

        function render() {
            const grid = document.getElementById('grid');
            if(serverData.length === 0) { grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding: 100px 20px; color:var(--text-muted); background:var(--card-bg); border-radius:28px; border: 1px dashed var(--border-color);">这里空空如也，点击底部 Dock 栏的 <strong style="color:var(--text-main)">添加</strong> 开始配置节点</div>'; return; }
            
            grid.innerHTML = serverData.map((item, index) => {
                const cLink = item.path ? \`\${originUrl}/\${item.path}\` : '';
                const modeText = item.mode === 'strict' ? '强力防 403 代理' : '基础代理';
                
                // 【编辑表单状态】
                if (item.isEditing) {
                    return \`
                    <div class="card" id="card-\${index}">
                        <div class="card-header" style="margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
                            <div class="card-title" style="font-size: 18px;">\${item.path ? '正在编辑' : '配置新节点'}</div>
                        </div>
                        <div class="field-group"><label>专属后缀 (分配的路径)</label><div class="input-wrapper"><input type="text" value="\${item.path}" onchange="updateVal(\${index}, 'path', this.value)" placeholder="如：line1"></div></div>
                        <div class="field-group"><label>节点名称</label><div class="input-wrapper"><input type="text" value="\${item.name}" onchange="updateVal(\${index}, 'name', this.value)" placeholder="如：AGA"></div></div>
                        <div class="field-group"><label>反代模式</label><div class="input-wrapper"><select onchange="updateVal(\${index}, 'mode', this.value)"><option value="normal" \${item.mode==='normal'?'selected':''}>基础代理</option><option value="strict" \${item.mode==='strict'?'selected':''}>强力防 403 代理</option></select></div></div>
                        <div class="field-group"><label>源站地址 (支持英文逗号隔开多个)</label><div class="input-wrapper"><input type="\${item.showEye?'text':'password'}" value="\${item.url}" onchange="updateVal(\${index}, 'url', this.value)" placeholder="http://源站IP:端口"><div class="icon-btn" onclick="toggleEye(\${index})">\${item.showEye ? iconEyeOpen : iconEyeClosed}</div></div></div>
                        <div class="field-group"><label>图片缓存加速 (Cloudflare)</label><div class="input-wrapper"><select onchange="updateVal(\${index}, 'cacheImages', this.value==='true')"><option value="false" \${!item.cacheImages?'selected':''}>停用加速</option><option value="true" \${item.cacheImages?'selected':''}>启用加速 (省流提速)</option></select></div></div>
                        <div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 12px;">
                            <button class="btn-theme" style="flex:1; justify-content:center;" onclick="cancelEdit(\${index})">取消</button>
                            <button class="btn-edit active" style="flex:1; justify-content:center; margin-right:0;" onclick="saveEdit(\${index})">保存设置</button>
                        </div>
                    </div>\`;
                } 
                
                // 【信息展示状态】
                return \`
                <div class="card" id="card-\${index}" draggable="true" ondragstart="dragStart(event, \${index})" ondragend="dragEnd(event)" ondragover="dragOver(event)" ondrop="drop(event, \${index})">
                    <div class="card-header" style="border-bottom: 1px solid var(--border-color); padding-bottom: 12px; margin-bottom: 8px;">
                        <div class="card-title">
                            <span class="drag-handle">\${iconDrag}</span> 
                            \${item.path || '未设置后缀'}
                        </div>
                        <div class="icon-btn" onclick="startEdit(\${index})" style="color: var(--primary);">\${iconEdit}</div>
                    </div>
                    
                    <div class="info-row"><span>名 称 :</span> <strong>\${item.name || '-'}</strong></div>
                    <div class="info-row"><span>代理模式 :</span> <strong>\${modeText}</strong></div>
                    <div class="info-row" style="display:flex; align-items:center; justify-content:space-between;">
                        <div style="display:flex; gap:8px; overflow:hidden;"><span>源站地址 :</span> <strong>\${item.showEye ? item.url : '••••••••••••'}</strong></div>
                        <div class="icon-btn" style="padding:4px;" onclick="toggleEye(\${index})">\${item.showEye ? iconEyeOpen : iconEyeClosed}</div>
                    </div>
                    <div class="info-row" style="display:flex; align-items:center; justify-content:space-between;">
                        <div style="display:flex; gap:8px; overflow:hidden;"><span>代理直连 :</span> <strong>\${cLink || '-'}</strong></div>
                        <div class="icon-btn" style="padding:4px; color:var(--primary);" onclick="copyTxt('\${cLink}')">\${iconCopy}</div>
                    </div>
                    
                    <div style="display:flex; justify-content: space-between; margin-top: 16px;">
                        <button class="btn-theme" style="padding: 10px 16px;" onclick="testPing(\${index})"><span id="ping-\${index}">\${item.latency}</span></button>
                        <button class="btn-danger" onclick="delCard(\${index})">删除节点</button>
                    </div>
                </div>\`;
            }).join(''); filterCards();
        }

        async function testPing(index) {
            const item = serverData[index]; if (!item.url) return updatePingUI(index, '无地址', 'var(--text-muted)');
            item.latency = '测速中...'; updatePingUI(index, item.latency, 'var(--primary)');
            try {
                const res = await fetch(apiBase + '/ping?target=' + encodeURIComponent(item.url));
                if (res.ok) { const ms = parseInt(await res.text()); item.latency = ms + ' ms'; updatePingUI(index, item.latency, ms > 400 ? 'var(--danger)' : (ms > 150 ? 'var(--warning)' : 'var(--success)')); } 
                else { item.latency = '访问超时'; updatePingUI(index, item.latency, 'var(--danger)'); }
            } catch(e) { item.latency = '连接异常'; updatePingUI(index, item.latency, 'var(--danger)'); }
        }
        function updatePingUI(i, t, c) { const b = document.getElementById(\`ping-\${i}\`); if(b) { b.innerHTML = t; b.style.color = c; } }

        function startEdit(index) {
            serverData[index]._original = { ...serverData[index] }; 
            serverData[index].isEditing = true; render();
        }
        function cancelEdit(index) {
            if(serverData[index]._original) Object.assign(serverData[index], serverData[index]._original);
            else serverData.splice(index, 1); 
            serverData[index].isEditing = false; render();
        }
        async function saveEdit(index) {
            if (!serverData[index].path || !serverData[index].url) return showToast('❌ 后缀路径和源站地址不能为空', 'var(--danger)');
            serverData[index].isEditing = false; render(); 
            testPing(index); await saveData(true);
        }

        function filterCards() { const kw = document.getElementById('searchInput').value.toLowerCase(); serverData.forEach((item, i) => { const c = document.getElementById('card-' + i); if (c) c.style.display = \`\${item.name} \${item.path} \${item.url}\`.toLowerCase().includes(kw) ? 'flex' : 'none'; }); }
        function addCard() { serverData.unshift({ path: '', url: '', name: '', mode: 'normal', cacheImages: false, showEye: false, isEditing: true, latency: '测试延迟' }); render(); showToast('已创建新配置，请填写'); }
        function delCard(index) { if(confirm('确定要彻底移除该节点配置吗？')) { serverData.splice(index, 1); render(); saveData(false); showToast('🗑️ 节点已移除', 'var(--text-muted)'); } }
        function updateVal(index, key, value) { serverData[index][key] = key === 'path' ? value.trim().replace(/[^a-zA-Z0-9_-]/g, '') : value; }
        function toggleEye(index) { serverData[index].showEye = !serverData[index].showEye; render(); }
        function copyTxt(text) { if(!text) return showToast('暂无内容可复制', 'var(--danger)'); navigator.clipboard.writeText(text).then(() => showToast('✅ 直连链接已复制')).catch(() => showToast('❌ 复制失败', 'var(--danger)')); }

        // Settings 面板逻辑
        function openSettings() { 
            const m = document.getElementById('settingsModal');
            m.style.display = 'flex'; 
            setTimeout(() => m.classList.add('show'), 10);
        }
        function closeSettings() { 
            const m = document.getElementById('settingsModal');
            m.classList.remove('show');
            setTimeout(() => m.style.display = 'none', 300);
        }
        
        async function changePassword() {
            const u = document.getElementById('newAdminUser').value, p = document.getElementById('newAdminPass').value;
            if(!u || !p) return showToast('账号和密码不能为空', 'var(--warning)');
            try {
                const res = await fetch(apiBase + '/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({newUser: u, newPass: p}) });
                if(res.ok) { showToast('✅ 安全信息已更新！'); document.getElementById('newAdminUser').value = ''; document.getElementById('newAdminPass').value = ''; closeSettings(); } 
                else showToast('❌ 更新失败', 'var(--danger)');
            } catch(e) { showToast('❌ 系统错误', 'var(--danger)'); }
        }

        function exportConfig() {
            if(serverData.length === 0) return showToast('没有可导出的数据', 'var(--warning)');
            const b = new Blob([JSON.stringify(serverData.filter(i=>i.path&&i.url).map(i=>({path:i.path,url:i.url,name:i.name,mode:i.mode,cacheImages:i.cacheImages})), null, 2)], { type: 'application/json' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = \`Emby_Nodes_\${new Date().toISOString().slice(0,10)}.json\`; a.click(); showToast('✅ 配置已导出');
            closeSettings();
        }
        function triggerImport() { 
            document.getElementById('importFile').click(); 
        }
        function handleImport(e) {
            const f = e.target.files[0]; if (!f) return; const r = new FileReader();
            r.onload = async ev => {
                try {
                    const d = JSON.parse(ev.target.result); if(!confirm('⚠️ 警告：导入将覆盖当前全部节点，确定继续吗？')) return;
                    const res = await fetch(apiBase, { method: 'POST', body: JSON.stringify(d) });
                    if(res.ok) { showToast('✅ 数据导入成功！'); closeSettings(); setTimeout(() => window.location.reload(), 1200); }
                } catch (err) { showToast('❌ 配置文件解析失败', 'var(--danger)'); }
            }; r.readAsText(f);
        }

        async function saveData(toast = true) {
            try {
                const res = await fetch(apiBase, { method: 'POST', body: JSON.stringify(serverData.filter(i=>i.path&&i.url).map(i=>({path:i.path,url:i.url,name:i.name,mode:i.mode,cacheImages:i.cacheImages}))) });
                if(res.ok) { if(toast) showToast('✅ 设置已自动保存'); } else showToast('❌ 云端同步失败', 'var(--danger)');
            } catch(e) { showToast('❌ 网络断开，请检查连接', 'var(--danger)'); }
        }

        function showToast(m, c = 'var(--text-main)') {
            const t = document.getElementById('toast'); 
            t.textContent = m; 
            
            if(c === 'var(--danger)') t.style.color = '#FF453A';
            else if(c === 'var(--success)') t.style.color = '#32D74B';
            else if(c === 'var(--warning)') t.style.color = '#FF9F0A';
            else t.style.color = c;

            t.classList.add('show');
            setTimeout(() => t.classList.remove('show'), 2500);
        }
        init();
    </script>
</body>
</html>
`;
