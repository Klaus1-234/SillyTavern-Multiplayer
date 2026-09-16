import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders, getThumbnailUrl, updateMessageBlock, updateViewMessageIds, updateSwipeCounter, stopGeneration, isStreamingEnabled, streamingProcessor, messageEdit } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { user_avatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';

const MODULE_NAME = 'multiplayer';
const TEMPLATE_PATH = 'third-party/Extension-Multiplayer';
const MP_VERSION = '1.7.10-en';
const MP_AUTHOR = 'klaus.1234.';

const defaultSettings = { sessionCode: '', hostUrl: '' };

// keep in sync with multiplayer.mjs
const MP_HTTP_TIMEOUT_MS = 10000;
const MP_POLL_INTERVAL_MS = 1000;
const MP_STREAM_TICK_MS = 400;
const MP_TYPING_SILENCE_MS = 1500;
const MP_TYPING_EXPIRY_MS = 3000;
const MP_BLOCK_TOAST_MS = 10000;
const MP_AVATAR_FETCH_TIMEOUT_MS = 5000;
const MP_HISTORY_MAX_MESSAGES = 500;
const MP_SWIPES_MAX = 100;
const MP_RENDER_CACHE_MAX = 500;
const MP_AVATAR_MAX_LENGTH = 700000;

let pollTimer = null;
let myUserId = null;
let lastTs = 0;
let active = false;
let starting = false;
let orderCounter = 0;
// server-issued (init/join), proves identity
let myToken = null;

function safeAvatarUrl(value) {
    return (typeof value === 'string'
        && /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(value)
        && value.length <= MP_AVATAR_MAX_LENGTH) ? value : '';
}

// st renders mes as html, strip active content before it hits the chat
function sanitizeRemote(value) {
    const text = String(value ?? '');
    try {
        const purifier = window.DOMPurify || DOMPurify;
        return purifier.sanitize(text, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['srcset'] });
    } catch (_) {
        return text.replace(/[<>&"']/g, '');
    }
}

const avatarMemory = {};
let lastBlockToast = 0;
// mpMsgId -> last rendered state, tells re-renders from new messages
const swipeStateCache = new Map();

function recordSwipeState(mpId, message) {
    swipeStateCache.set(mpId, snapshotSwipeState(message));
    while (swipeStateCache.size > MP_RENDER_CACHE_MAX) {
        swipeStateCache.delete(swipeStateCache.keys().next().value);
    }
}

function snapshotSwipeState(m) {
    return {
        swipe_id: typeof m?.swipe_id === 'number' ? m.swipe_id : 0,
        len: Array.isArray(m?.swipes) ? m.swipes.length : 0,
        mes: m?.mes || '',
    };
}

function getSettings() { return extension_settings[MODULE_NAME]; }

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    for (const key of Object.keys(defaultSettings)) {
        if (!(key in extension_settings[MODULE_NAME])) extension_settings[MODULE_NAME][key] = defaultSettings[key];
    }
    saveSettingsDebounced();
}

function setStatus(state, text) {
    const dot = document.getElementById('mp_status_dot');
    const label = document.getElementById('mp_status_text');
    if (!dot || !label) return;
    dot.classList.remove('ok', 'off', 'warn');
    dot.classList.add(state);
    label.textContent = text;
}

function mpHeaders(isRemote) {
    // csrf token belongs to our own ST, never send it to the remote host
    const h = isRemote ? { 'Content-Type': 'application/json' } : { ...getRequestHeaders() };
    h['ngrok-skip-browser-warning'] = 'true';
    if (myToken) h['X-MP-Token'] = myToken;
    return h;
}

async function apiRequest(method, url, body = null, timeoutMs = MP_HTTP_TIMEOUT_MS) {
    try {
        const isRemote = /^https?:\/\//i.test(url);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        // skip ngrok browser warning
        const options = { method, headers: mpHeaders(isRemote), signal: ctl.signal };
        if (method === 'POST') options.body = JSON.stringify(body || {});
        const r = await fetch(url, options);
        clearTimeout(timer);
        window.__mp_lastHttpStatus = r.status;
        if (!r.ok) return null;
        return await r.json();
    } catch (_) { window.__mp_lastHttpStatus = 0; return null; }
}

function apiPost(url, body, timeoutMs = MP_HTTP_TIMEOUT_MS) {
    return apiRequest('POST', url, body, timeoutMs);
}

function apiGet(url, timeoutMs = MP_HTTP_TIMEOUT_MS) {
    return apiRequest('GET', url, null, timeoutMs);
}

function getMyPersona() {
    const pn = power_user.personas?.[user_avatar] || power_user.default_persona || 'Me';
    // persona_descriptions[x] is an object in modern st, string in old
    const descRaw = power_user.persona_descriptions?.[user_avatar];
    const pd = typeof descRaw === 'string' ? descRaw : (descRaw?.description || '');
    return { name: pn, description: pd || '', avatar: user_avatar || '' };
}

// host

async function createRoom() {
    // sync guard, double click used to register listeners twice
    if (active || starting) return;
    starting = true;
    try {
    const settings = getSettings();
    const code = settings.sessionCode.trim();
    if (!code) { toastr.error('Enter a room code.', 'Multiplayer'); return; }
    if (code.length < 6) { toastr.error('Room code: 6 characters minimum (letters, numbers, _ -). 16+ random recommended.', 'Multiplayer'); return; }

    const res = await apiPost('/api/plugins/multiplayer/init', { code, host: { ...getMyPersona(), order: 0 } });
    if (!res || !res.ok) {
        if (window.__mp_lastHttpStatus === 401) toastr.error('Your ST session expired: reload the page and log in.', 'Multiplayer');
        else toastr.error('Could not start the room. Is multiplayer.mjs in plugins/ and config.yaml ready (plugins, CORS, no CSRF)? Restart ST. See README.', 'Multiplayer');
        return;
    }

    myUserId = res.hostId;
    myToken = res.token || null;
    active = true;
    lastTs = 0;
    window.__mp_chatId = getContext()?.chatId || null;
    // seed from max stamped order, blind reset makes clients drop live messages
    orderCounter = 0;
    for (const message of (getContext()?.chat || [])) {
        if (typeof message.extra?.mpOrder === 'number' && message.extra.mpOrder > orderCounter) orderCounter = message.extra.mpOrder;
    }

    setStatus('ok', `Host — room ${code}`);
    toastr.success(`Room ${code} created.`, 'Multiplayer');

    await pushFullChat();
    startHostPoll();

    eventSource.on(event_types.USER_MESSAGE_RENDERED, onLocalMessage);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onLocalMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted_PatchPersonas);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded_RestorePersonas);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded_RestorePersonas);
    refreshKnownIds();
    ensureHudTypingEl();
    attachTypingInputListener();

    $('#mp_create').prop('disabled', true);
    $('#mp_destroy').prop('disabled', false);
    } finally {
        starting = false;
    }
}

async function destroyRoom() {
    if (!active) return;
    // clients notice via poll and leave on their own, host chat stays untouched
    try {
        await apiPost('/api/plugins/multiplayer/destroy', {
            code: getSettings().sessionCode, userId: myUserId, token: myToken,
        });
    } catch (_) { }
    eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, onLocalMessage);
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onLocalMessage);
    eventSource.removeListener(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.removeListener(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.removeListener(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted_PatchPersonas);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded_RestorePersonas);
    eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationEnded_RestorePersonas);
    resetPersonaPatch();
    if (hostStreamingTimer) { clearInterval(hostStreamingTimer); hostStreamingTimer = null; }
    hostStreamingTarget = null;
    clearInterval(pollTimer); pollTimer = null;
    clearTypingSend();
    for (const id of Object.keys(typingTimeouts)) delete typingTimeouts[id];
    const hud = document.getElementById('mp_hud_typing');
    if (hud) hud.style.display = 'none';
    const ind = document.getElementById('mp_typing');
    if (ind) { ind.textContent = ''; ind.style.display = 'none'; }
    active = false; starting = false; myUserId = null; myToken = null; lastTs = 0;
    window.__mp_chatId = undefined;
    for (const k of Object.keys(avatarMemory)) delete avatarMemory[k];
    setStatus('off', 'Room ended');
    toastr.info('Room closed.', 'Multiplayer');
    $('#mp_create').prop('disabled', false);
    $('#mp_destroy').prop('disabled', true);
}

function readBlobAsDataUrl(blob, timeoutMs = MP_AVATAR_FETCH_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(''); } }, timeoutMs);
        try {
            const fr = new FileReader();
            fr.onload = () => { if (!done) { done = true; clearTimeout(timer); resolve(fr.result); } };
            fr.onerror = () => { if (!done) { done = true; clearTimeout(timer); resolve(''); } };
            fr.readAsDataURL(blob);
        } catch { if (!done) { done = true; clearTimeout(timer); resolve(''); } }
    });
}

async function avatarToDataUrl(type, file) {
    if (!file) return '';
    if (/^(data:|https?:\/\/|\/)/.test(file)) {
        if (file.startsWith('data:')) return file;
        try {
            const res = await fetch(file);
            if (!res.ok) return '';
            return await readBlobAsDataUrl(await res.blob());
        } catch { return ''; }
    }
    const asDataUrl = async (url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) return '';
            return await readBlobAsDataUrl(await res.blob());
        } catch { return ''; }
    };
    // thumbnail first, /img/ fallback
    return await asDataUrl(getThumbnailUrl(type, file, true))
        || await asDataUrl(`/img/${encodeURIComponent(file)}`);
};

async function onLocalMessage(messageId) {
    if (!active || !myUserId) return;
    if (!mpRightChat()) return;
    const ctx = getContext();
    if (!ctx?.chat) return;
    if (messageId !== ctx.chat.length - 1) return;
    const last = ctx.chat[messageId];
    if (!last || last.extra?.fromMultiplayer || last.is_system) return;

    // already synced: propagate swipe/update instead of duplicating
    const existingId = last.extra?.mpMsgId;
    if (existingId) {
        const cur = snapshotSwipeState(last);
        const prev = swipeStateCache.get(existingId);
        recordSwipeState(existingId, last);
        if (!prev) { refreshKnownIds(); return; }
        if (cur.swipe_id !== prev.swipe_id || cur.len !== prev.len) {
            await postOp({ op: 'swipe', target: existingId, content: last.mes || '',
                swipes: Array.isArray(last.swipes) ? last.swipes : [last.mes || ''],
                swipe_id: cur.swipe_id,
                swipe_info: Array.isArray(last.swipe_info) ? last.swipe_info : [] });
        } else if (cur.mes !== prev.mes) {
            await postOp({ op: 'update', target: existingId, content: last.mes || '', name: last.name });
        }
        refreshKnownIds();
        return;
    }
    await postChatMessageAsNew(ctx, messageId);
}

async function postChatMessageAsNew(ctx, index) {
    const last = ctx.chat[index];
    if (!last || last.extra?.fromMultiplayer || last.is_system) return null;
    const isUser = last.is_user;
    const name = isUser ? (ctx.name1 || getMyPersona().name) : (last.character_name || last.name || getMyPersona().name);
    const userId = isUser ? myUserId : (last.character_name || last.name || 'System');
    const avatar = await resolveAvatarForMessage(ctx, last, isUser);
    const finalAvatar = avatar || avatarMemory[userId] || '';
    if (finalAvatar) avatarMemory[userId] = finalAvatar;

    orderCounter++;
    const nowTs = Date.now();
    const dedupId = `${userId}_${orderCounter}`;
    last.extra = last.extra || {};
    last.extra.mpMsgId = dedupId;
    last.extra.mpOrder = orderCounter;
    last.extra.mpTs = nowTs;
    recordSwipeState(dedupId, last);
    const posted = await apiPost('/api/plugins/multiplayer/msg', {
        code: getSettings().sessionCode,
        userId,
        token: myToken,
        name,
        content: last.mes,
        avatar: finalAvatar,
        order: orderCounter,
        ts: nowTs,
    });
    if (!posted) {
        toastr.warning(`Could not send "${String(last.mes || '').slice(0, 40)}..." to the room. Check your connection.`, 'Multiplayer');
        return null;
    }
    cutTypingNotice();
    return dedupId;
}

async function onMessageSwiped(messageId) {
    if (!active || !myUserId || mpClientActive()) return;
    if (!mpRightChat()) return;
    const ctx = getContext();
    const msg = ctx?.chat?.[messageId];
    if (!msg || msg.is_system || msg.extra?.fromMultiplayer) return;
    let mpId = msg.extra?.mpMsgId;
    if (!mpId) {
        // publish first so the op has a target
        mpId = await postChatMessageAsNew(ctx, messageId);
        if (!mpId) return;
    }
    await postOp({ op: 'swipe', target: mpId, content: msg.mes || '',
        swipes: Array.isArray(msg.swipes) ? msg.swipes : [msg.mes || ''],
        swipe_id: typeof msg.swipe_id === 'number' ? msg.swipe_id : 0,
        swipe_info: Array.isArray(msg.swipe_info) ? msg.swipe_info : [] });
    // so the next rendered event compares equal and skips re-posting
    recordSwipeState(mpId, msg);
    refreshKnownIds();
}

async function resolveAvatarForMessage(ctx, msg, isUser) {
    if (isUser) {
        return await avatarToDataUrl('persona', user_avatar);
    }
    const byIndex = ctx?.characters?.[ctx?.characterId];
    if (byIndex?.avatar) {
        const b64 = await avatarToDataUrl('avatar', byIndex.avatar);
        if (b64) return b64;
    }
    const byName = ctx?.characters?.find(c => c.name === (msg.character_name || msg.name));
    if (byName?.avatar && byName !== byIndex) {
        const b64 = await avatarToDataUrl('avatar', byName.avatar);
        if (b64) return b64;
    }
    return '';
}

async function pushFullChat() {
    if (!active || !myUserId) return;
    const ctx = getContext();
    const character = ctx?.characters?.[ctx?.characterId]
        ?? ctx?.characters?.find(c => c.name === ctx?.chat?.[ctx.chat.length - 1]?.character_name);
    const chat = ctx?.chat || [];
    const userAvB64 = await avatarToDataUrl('persona', user_avatar);
    if (userAvB64) avatarMemory[myUserId] = userAvB64;
    const slice = chat.slice(-MP_HISTORY_MAX_MESSAGES);
    const msgs = [];
    for (const m of slice) {
        // keep original identity or clients see ghost dupes on every sync
        if (m.extra?.fromMultiplayer) {
            let fOrder = m.extra.mpOrder;
            let fTs = m.extra.mpTs;
            if (fOrder == null) { orderCounter++; fOrder = orderCounter; }
            if (fTs == null) { fTs = Date.now(); }
            m.extra.mpMsgId = `${m.extra.mpUserId}_${fOrder}`;
            m.extra.mpOrder = fOrder;
            m.extra.mpTs = fTs;
            msgs.push({
                userId: m.extra.mpUserId,
                name: m.name,
                content: m.mes || '',
                avatar: m.force_avatar || avatarMemory[m.extra.mpUserId] || '',
                order: fOrder,
                ts: fTs,
            });
            continue;
        }
        // stamp natives so the poll echo is recognized
        const nUserId = m.is_user ? myUserId : (m.character_name || m.name || 'System');
        let nOrder = m.extra?.mpOrder;
        let nTs = m.extra?.mpTs;
        if (nOrder == null) { orderCounter++; nOrder = orderCounter; }
        if (nTs == null) { nTs = Date.now(); }
        let nAvatar = '';
        if (m.is_user) {
            nAvatar = userAvB64 || avatarMemory[myUserId] || '';
        } else {
            nAvatar = await resolveAvatarForMessage(ctx, m, false);
            if (!nAvatar && avatarMemory[nUserId]) nAvatar = avatarMemory[nUserId];
        }
        if (nAvatar) avatarMemory[nUserId] = nAvatar;
        m.extra = m.extra || {};
        m.extra.mpMsgId = `${nUserId}_${nOrder}`;
        m.extra.mpOrder = nOrder;
        m.extra.mpTs = nTs;
        msgs.push({
            userId: nUserId,
            name: m.is_user ? (ctx.name1 || 'Me') : (m.character_name || m.name || 'System'),
            content: m.mes || '',
            avatar: nAvatar,
            order: nOrder,
            ts: nTs,
        });
    }
    const host = { ...getMyPersona(), ts: Date.now() };
    const mainCharAv = (character?.name && avatarMemory[character.name]) || '';
    const char = character ? { name: character.name, avatar: mainCharAv } : null;
    await apiPost('/api/plugins/multiplayer/sync', {
        code: getSettings().sessionCode, userId: myUserId, token: myToken,
        messages: msgs, character: char, host,
    });
    refreshKnownIds();
}

// shared poll loop, '' = own ST, host URL = client
function startPollLoop(base, code, onClosed = null) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        const data = await apiGet(`${base}/api/plugins/multiplayer/poll?code=${encodeURIComponent(code)}&since=${lastTs}&uid=${encodeURIComponent(myUserId || '')}`);
        if (!data) return;
        if (data.closed) {
            if (onClosed) await onClosed();
            return;
        }
        if (!data.ok) return;
        if (!active) return;
        // paused on another chat, cursor frozen until back
        if (!mpRightChat()) return;
        if (data.messages?.length) {
            for (const m of data.messages) {
                if (m.userId === myUserId) continue;
                if (m.op === 'delete') { applyRemoteDelete(m.target); continue; }
                if (m.op === 'update') { applyRemoteUpdate(m.target, m.content); continue; }
                if (m.op === 'swipe') { applyRemoteSwipe(m.target, m); continue; }
                insertMessage(m);
            }
            lastTs = data.lastTs || lastTs;
        }
        if (Array.isArray(data.typings)) updateTypingFromPoll(data);
        else if (data.typing && data.typing.userId !== myUserId) updateTyping(data.typing);
        if (data.users) updatePlayerList(data.users);
    }, MP_POLL_INTERVAL_MS);
}

function startHostPoll() {
    startPollLoop('', getSettings().sessionCode, null);
}

// client

function isLocalHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
        || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
        || hostname.endsWith('.local') || hostname.endsWith('.lan');
}

async function connectToHost() {
    if (active || starting) return;
    starting = true;
    try {
    const settings = getSettings();
    let baseUrl = settings.hostUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) { toastr.error('Paste the host URL.', 'Multiplayer'); return; }
    try {
        const u = new URL(baseUrl);
        if (u.protocol === 'http:' && !isLocalHostname(u.hostname.toLowerCase())) {
            toastr.error('Insecure URL: use https:// for remote hosts (http only ok on local/LAN).', 'Multiplayer');
            return;
        }
    } catch (_) { toastr.error('Invalid host URL.', 'Multiplayer'); return; }

    let code = settings.sessionCode.trim();
    if (!code) {
        try { const fromUrl = (new URL(baseUrl + '/api/plugins/multiplayer/info')).searchParams.get('code'); if (fromUrl) code = fromUrl; } catch (_) { }
    }
    if (!code) { toastr.error('No room code.', 'Multiplayer'); return; }

    const userId = 'c' + Date.now().toString(36);
    const joined = await apiPost(`${baseUrl}/api/plugins/multiplayer/join`, { code, userId, persona: getMyPersona() });
    if (!joined || !joined.ok) {
        if (window.__mp_lastHttpStatus === 401) toastr.error('The host rejected the join (401). Tell them to check their proxy password.', 'Multiplayer');
        else toastr.error('Could not join. Code and URL correct? The host needs config.yaml ready and ST restarted. See README.', 'Multiplayer');
        return;
    }

    active = true;
    lastTs = 0;
    myUserId = userId;
    myToken = joined.token || null;
    window.__mp_baseUrl = baseUrl;
    window.__mp_code = code;
    window.__mp_chatId = getContext()?.chatId || null;

    setStatus('ok', `Connected — room ${code}`);
    toastr.success(`Joined room ${code}`, 'Multiplayer');

    if (joined.messages?.length) {
        joined.messages.sort((a, b) => (a.order || 0) - (b.order || 0));
        for (const message of joined.messages) insertMessage(message);
    }
    if (joined.users) updatePlayerList(joined.users);

    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    // safety net: abort stray local generation
    eventSource.on(event_types.GENERATION_STARTED, onBlockGeneration);
    document.body.classList.add('mp-client');
    refreshKnownIds();
    ensureHudTypingEl();
    attachTypingInputListener();
    startPollLoop(window.__mp_baseUrl, window.__mp_code, async () => {
        await disconnectFromHost(false, 'The host closed the room.');
    });

    $('#mp_connect').prop('disabled', true);
    $('#mp_disconnect').prop('disabled', false);
    } finally {
        starting = false;
    }
}

async function disconnectFromHost(notifyLeave = true, toastMsg = null) {
    if (!active) return;
    // leave before clearing state
    if (notifyLeave && window.__mp_baseUrl && window.__mp_code && myUserId) {
        try {
            await apiPost(`${window.__mp_baseUrl}/api/plugins/multiplayer/leave`, {
                code: window.__mp_code, userId: myUserId, token: myToken, name: getMyPersona().name,
            });
        } catch (_) { }
    }
    eventSource.removeListener(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.removeListener(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.GENERATION_STARTED, onBlockGeneration);
    document.body.classList.remove('mp-client');
    clearInterval(pollTimer); pollTimer = null;
    clearTypingSend();
    active = false; starting = false; myUserId = null; myToken = null; lastTs = 0;
    window.__mp_chatId = undefined;
    for (const k of Object.keys(avatarMemory)) delete avatarMemory[k];
    for (const k of Object.keys(typingTimeouts)) delete typingTimeouts[k];
    const typingIndicator = document.getElementById('mp_typing');
    if (typingIndicator) { typingIndicator.textContent = ''; typingIndicator.style.display = 'none'; }
    const hud = document.getElementById('mp_hud_typing');
    if (hud) hud.style.display = 'none';
    window.__mp_baseUrl = null; window.__mp_code = null;
    setStatus('off', 'Disconnected');
    toastr.info(toastMsg || 'Disconnected from host.', 'Multiplayer');
    $('#mp_connect').prop('disabled', false);
    $('#mp_disconnect').prop('disabled', true);
    clearMultiplayerMessages();
    refreshKnownIds();
}

// shared

const pendingInserts = new Set();

async function insertMessage(msg) {
    const ctx = getContext();
    if (!ctx || !ctx.chat) return;
    if (msg.op) return;
    const dedupId = `${msg.userId}_${msg.order ?? msg.ts ?? 0}`;
    // async guard, same message twice used to slip through
    if (pendingInserts.has(dedupId)) return;
    if (ctx.chat.some(m => m.extra?.mpMsgId === dedupId)) return;
    pendingInserts.add(dedupId);
    try {

    if (msg.avatar) { const validAvatar = safeAvatarUrl(msg.avatar); if (validAvatar) avatarMemory[msg.userId] = validAvatar; }
    let avatarUrl = safeAvatarUrl(msg.avatar) || safeAvatarUrl(avatarMemory[msg.userId]) || '';
    if (!avatarUrl && msg.name && !msg.is_system) {
        const localChar = ctx?.characters?.find(c => c.name === msg.name);
        if (localChar?.avatar) {
            avatarUrl = await avatarToDataUrl('avatar', localChar.avatar);
            if (avatarUrl) avatarMemory[msg.userId] = avatarUrl;
        }
    }
    const obj = {
        name: sanitizeRemote(msg.name || 'Someone'),
        mes: sanitizeRemote(msg.content || ''),
        character_name: sanitizeRemote(msg.name || 'Someone'),
        is_user: msg.userId === myUserId,
        is_system: msg.userId === '__system',
        force_avatar: avatarUrl,
        extra: { fromMultiplayer: true, mpMsgId: dedupId, mpUserId: msg.userId, mpOrder: msg.order ?? null, mpTs: msg.ts ?? null },
        send_date: new Date(msg.ts || Date.now()).toISOString(),
    };
    ctx.chat.push(obj);
    ctx.addOneMessage(obj);
    // host persists, client chat is temporary
    if (window.__mp_baseUrl === undefined) {
        ctx.saveChat();
    }
    if (ctx.scrollChatToBottom) ctx.scrollChatToBottom();
    refreshKnownIds();
    } finally {
        pendingInserts.delete(dedupId);
    }
}

// MESSAGE_DELETED doesn't say what was removed, diff known ids
let knownIds = [];

function currentIdList() {
    const ctx = getContext();
    if (!ctx?.chat) return [];
    return ctx.chat.map(message => message.extra?.mpMsgId || null);
}

function refreshKnownIds() {
    knownIds = currentIdList();
    markOwnMessages();
}

// client mode: tag own message blocks so css can show edit/delete
function markOwnMessages() {
    if (!mpClientActive()) return;
    document.querySelectorAll('#chat .mes').forEach(el => {
        const idx = Number(el.getAttribute('mesid'));
        el.classList.toggle('mp-own', getContext()?.chat?.[idx]?.extra?.mpUserId === myUserId);
    });
}

async function postOp(payload) {
    if (window.__mp_baseUrl) {
        return await apiPost(`${window.__mp_baseUrl}/api/plugins/multiplayer/msg`, {
            code: window.__mp_code, userId: myUserId, token: myToken, ...payload,
        });
    }
    return await apiPost('/api/plugins/multiplayer/msg', {
        code: getSettings().sessionCode, userId: myUserId, token: myToken, ...payload,
    });
}

async function onMessageDeleted() {
    if (!active || !myUserId) return;
    if (!mpRightChat()) return;
    const current = currentIdList();
    const missing = knownIds.filter(id => id && !current.includes(id));
    refreshKnownIds();
    for (const target of new Set(missing)) {
        await postOp({ op: 'delete', target });
    }
}

async function onMessageEdited(messageId) {
    if (!active || !myUserId) return;
    if (!mpRightChat()) return;
    const ctx = getContext();
    const msg = ctx?.chat?.[messageId];
    if (!msg || !msg.extra?.mpMsgId) return;
    await postOp({ op: 'update', target: msg.extra.mpMsgId, content: msg.mes || '', name: msg.name });
    refreshKnownIds();
}

function applyRemoteDelete(target) {
    const ctx = getContext();
    if (!ctx?.chat) return;
    const idx = ctx.chat.findIndex(m => m.extra?.mpMsgId === target);
    if (idx === -1) return;
    ctx.chat.splice(idx, 1);
    document.querySelector(`#chat .mes[mesid="${idx}"]`)?.remove();
    updateViewMessageIds();
    if (window.__mp_baseUrl === undefined) ctx.saveChat();
    refreshKnownIds();
}

function applyRemoteUpdate(target, content) {
    const ctx = getContext();
    if (!ctx?.chat) return;
    const idx = ctx.chat.findIndex(m => m.extra?.mpMsgId === target);
    if (idx === -1) return;
    ctx.chat[idx].mes = sanitizeRemote(content ?? '');
    updateMessageBlock(idx, ctx.chat[idx]);
    if (window.__mp_baseUrl === undefined) ctx.saveChat();
    refreshKnownIds();
}

async function applyRemoteSwipe(target, op) {
    const ctx = getContext();
    if (!ctx?.chat) return;
    const idx = ctx.chat.findIndex(m => m.extra?.mpMsgId === target);
    if (idx === -1) return;
    const msg = ctx.chat[idx];
    if (!Array.isArray(op.swipes) || op.swipes.length === 0) return;
    msg.swipes = op.swipes.slice(0, MP_SWIPES_MAX).map(sanitizeRemote);
    msg.swipe_id = Math.min(Math.max(0, op.swipe_id | 0), msg.swipes.length - 1);
    if (Array.isArray(op.swipe_info)) msg.swipe_info = op.swipe_info.slice(0, MP_SWIPES_MAX);
    msg.mes = typeof op.content === 'string' && op.content ? sanitizeRemote(op.content) : msg.swipes[msg.swipe_id];
    updateMessageBlock(idx, msg);
    try { await updateSwipeCounter(idx, { message: msg }); } catch (_) { }
    if (window.__mp_baseUrl === undefined) ctx.saveChat();
    refreshKnownIds();
}

function clearMultiplayerMessages() {
    const ctx = getContext();
    if (!ctx?.chat) return;
    // descending so splice indexes stay valid
    const idxs = [];
    ctx.chat.forEach((m, i) => { if (m.extra?.fromMultiplayer) idxs.push(i); });
    if (idxs.length === 0) return;
    idxs.sort((a, b) => b - a);
    for (const idx of idxs) {
        ctx.chat.splice(idx, 1);
        document.querySelector(`#chat .mes[mesid="${idx}"]`)?.remove();
    }
    updateViewMessageIds();
}

function updatePlayerList(users) {
    const listEl = document.getElementById('mp_players');
    if (!listEl) return;
    listEl.textContent = users?.length ? users.map(u => u.persona?.name || u.userId || '?').join(', ') : '...';
    rebuildRemotePersonas(users);
}

// typing pings, silenced after inactivity or send
let typingTimeouts = {};
let typingSendTimer = null;
let typingSent = false;
let typingListenerAttached = false;

function ensureHudTypingEl() {
    let el = document.getElementById('mp_hud_typing');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mp_hud_typing';
    el.className = 'mp-hud-typing';
    el.style.display = 'none';
    // between chat and the input bar
    const sheld = document.getElementById('sheld');
    const formSheld = document.getElementById('form_sheld');
    if (sheld && formSheld && formSheld.parentNode === sheld) {
        sheld.insertBefore(el, formSheld);
    } else if (formSheld) {
        const sendForm = document.getElementById('send_form');
        if (sendForm) formSheld.insertBefore(el, sendForm);
        else formSheld.appendChild(el);
    } else {
        document.body.appendChild(el);
    }
    return el;
}

async function postTyping(isTyping) {
    if (!active || !myUserId) return;
    const code = window.__mp_baseUrl ? window.__mp_code : getSettings().sessionCode;
    const base = window.__mp_baseUrl || '';
    if (!code) return;
    const url = base ? `${base}/api/plugins/multiplayer/msg` : '/api/plugins/multiplayer/msg';
    let avatarUrl = avatarMemory[myUserId] || '';
    if (!avatarUrl && isTyping) {
        try { avatarUrl = await avatarToDataUrl('persona', user_avatar); if (avatarUrl) avatarMemory[myUserId] = avatarUrl; } catch (_) {}
    }
    apiPost(url, { code, userId: myUserId, token: myToken, name: getMyPersona().name, avatar: avatarUrl, typing: isTyping }).catch(() => {});
}

function cutTypingNotice() {
    if (!typingSent) return;
    typingSent = false;
    clearTimeout(typingSendTimer);
    postTyping(false);
}

function handleTypingInput() {
    if (!active || !myUserId || !mpRightChat()) return;
    const sendTextarea = document.getElementById('send_textarea');
    const hasText = !!(sendTextarea && String(sendTextarea.value).trim());
    if (!hasText) {
        cutTypingNotice();
        return;
    }
    if (!typingSent) {
        typingSent = true;
        postTyping(true);
    }
    clearTimeout(typingSendTimer);
    typingSendTimer = setTimeout(() => {
        typingSent = false;
        postTyping(false);
    }, MP_TYPING_SILENCE_MS);
}

function attachTypingInputListener() {
    if (typingListenerAttached) return;
    typingListenerAttached = true;
    document.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'send_textarea') handleTypingInput();
    });
    document.addEventListener('keydown', (e) => {
        if (e.target && e.target.id === 'send_textarea' && (e.key === 'Backspace' || e.key === 'Delete')) {
            // let the input update first
            setTimeout(handleTypingInput, 0);
        }
    });
}

function clearTypingSend() {
    typingSent = false;
    clearTimeout(typingSendTimer);
    typingSendTimer = null;
    try { postTyping(false); } catch (_) {}
}

function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function trackTypingEntry(entry, now) {
    if (!entry || !entry.typing) { delete typingTimeouts[entry?.userId]; return; }
    const avatarUrl = safeAvatarUrl(entry.avatar) || safeAvatarUrl(avatarMemory[entry.userId]) || '';
    if (avatarUrl) avatarMemory[entry.userId] = avatarUrl;
    typingTimeouts[entry.userId] = { exp: now + MP_TYPING_EXPIRY_MS, name: entry.name || entry.userId, avatar: avatarUrl };
}

function pruneExpiredTyping(now) {
    for (const [id, v] of Object.entries(typingTimeouts)) if (now > v.exp) delete typingTimeouts[id];
}

function renderTypingEntries() {
    const entries = Object.entries(typingTimeouts).filter(([id]) => id !== myUserId);
    const names = entries.map(([, v]) => v.name || v);
    const text = names.length ? (names.join(', ') + ' is typing...') : '';
    const avatar = entries.length === 1 ? (entries[0][1].avatar || '') : '';

    const ind = document.getElementById('mp_typing');
    if (ind) {
        ind.textContent = text;
        ind.style.display = text ? 'block' : 'none';
    }
    const hud = ensureHudTypingEl();
    if (text) {
        hud.innerHTML = avatar
            ? `<img class="mp-hud-avatar" src="${escHtml(avatar)}" alt=""><span>${escHtml(text)}</span>`
            : `<span>${escHtml(text)}</span>`;
        hud.style.display = 'flex';
    } else {
        hud.textContent = '';
        hud.style.display = 'none';
    }
}

// legacy: single object or list
function updateTyping(typing) {
    let list = [];
    if (Array.isArray(typing)) list = typing;
    else if (typing && typing.userId) list = [typing];
    else if (typing && Array.isArray(typing.typings)) list = typing.typings;

    const now = Date.now();
    for (const entry of list) trackTypingEntry(entry, now);
    pruneExpiredTyping(now);
    renderTypingEntries();
}

// reconcile: whoever is missing from the list stopped typing
function updateTypingFromPoll(data) {
    if (!data) return;
    if (Array.isArray(data.typings)) {
        const now = Date.now();
        const present = new Set();
        for (const entry of data.typings) {
            if (!entry.typing || entry.userId === myUserId) continue;
            present.add(entry.userId);
            trackTypingEntry(entry, now);
        }
        for (const id of Object.keys(typingTimeouts)) {
            if (id === myUserId) continue;
            if (!present.has(id)) delete typingTimeouts[id];
        }
        renderTypingEntries();
        return;
    }
    if (data.typing) updateTyping(data.typing);
    else {
        pruneExpiredTyping(Date.now());
        const entries = Object.entries(typingTimeouts).filter(([id]) => id !== myUserId);
        if (entries.length === 0) {
            const ind = document.getElementById('mp_typing');
            if (ind) { ind.textContent = ''; ind.style.display = 'none'; }
            const hud = document.getElementById('mp_hud_typing');
            if (hud) hud.style.display = 'none';
        }
    }
}

// remote personas ride the vanilla persona_description slot (openai.js reads it per generation)
let remotePersonas = new Map();
let personaPatchDepth = 0;
let originalPersonaDescription = null;

function rebuildRemotePersonas(users) {
    remotePersonas.clear();
    for (const u of (users || [])) {
        if (!u.userId || u.userId === myUserId) continue;
        const name = u.persona?.name || u.userId;
        // description may arrive as object in modern st
        const rawDesc = u.persona?.description;
        const description = (typeof rawDesc === 'string' ? rawDesc : (rawDesc?.description || '')).trim();
        remotePersonas.set(u.userId, { name, description });
    }
}

function buildRemotePersonasBlock() {
    const entries = [...remotePersonas.values()].filter(p => p.description);
    if (entries.length === 0) return '';
    return '\n\n[Players connected to this shared chat]\n'
        + entries.map(p => `- ${p.name}: ${p.description}`).join('\n');
}

async function onGenerationStarted_PatchPersonas() {
    if (!active || window.__mp_baseUrl !== undefined) return;
    const block = buildRemotePersonasBlock();
    if (block) {
        if (personaPatchDepth === 0) {
            originalPersonaDescription = power_user.persona_description || '';
            power_user.persona_description = originalPersonaDescription + block;
        }
        personaPatchDepth++;
    }
    startHostStreamingSync();
}

async function onGenerationEnded_RestorePersonas() {
    stopHostStreamingSync();
    if (personaPatchDepth <= 0) return;
    personaPatchDepth--;
    if (personaPatchDepth === 0 && originalPersonaDescription !== null) {
        power_user.persona_description = originalPersonaDescription;
        originalPersonaDescription = null;
    }
}

function resetPersonaPatch() {
    if (personaPatchDepth > 0 && originalPersonaDescription !== null) {
        power_user.persona_description = originalPersonaDescription;
    }
    personaPatchDepth = 0;
    originalPersonaDescription = null;
    remotePersonas.clear();
}

// host streams partials to clients (host setting only)
let hostStreamingTimer = null;
let hostStreamingTarget = null;

async function startHostStreamingSync() {
    if (hostStreamingTimer) clearInterval(hostStreamingTimer);
    hostStreamingTarget = null;
    try { if (!isStreamingEnabled()) return; } catch (_) {}
    hostStreamingTimer = setInterval(async () => {
        if (!active || !mpRightChat() || window.__mp_baseUrl !== undefined) return;
        const ctx = getContext();
        if (!ctx?.chat) return;
        let msgId = null;
        try { msgId = streamingProcessor?.messageId; } catch (_) {}
        if (msgId == null || msgId < 0 || msgId >= ctx.chat.length) msgId = ctx.chat.length - 1;
        const msg = ctx.chat[msgId];
        if (!msg || msg.is_system || msg.extra?.fromMultiplayer || msg.is_user) return;
        let mpId = msg.extra?.mpMsgId || hostStreamingTarget;
        if (!mpId) {
            // first chunk may land before rendered stamps it
            const character = ctx.characters?.[ctx.characterId];
            const name = msg.character_name || msg.name || character?.name || 'System';
            const userId = name;
            let avatar = '';
            try { avatar = await resolveAvatarForMessage(ctx, msg, false); } catch (_) {}
            if (avatar) avatarMemory[userId] = avatar;
            else avatar = avatarMemory[userId] || '';
            orderCounter++;
            mpId = `${userId}_${orderCounter}`;
            msg.extra = msg.extra || {};
            msg.extra.mpMsgId = mpId;
            msg.extra.mpOrder = orderCounter;
            msg.extra.mpTs = Date.now();
            recordSwipeState(mpId, msg);
            hostStreamingTarget = mpId;
            await apiPost('/api/plugins/multiplayer/msg', {
                code: getSettings().sessionCode,
                userId, token: myToken, name, content: msg.mes || '', avatar, order: orderCounter, ts: Date.now(),
            });
            return;
        }
        hostStreamingTarget = mpId;
        await postOp({ op: 'update', target: mpId, content: msg.mes || '' });
    }, MP_STREAM_TICK_MS);
}

function stopHostStreamingSync() {
    if (hostStreamingTimer) { clearInterval(hostStreamingTimer); hostStreamingTimer = null; }
    const target = hostStreamingTarget;
    hostStreamingTarget = null;
    if (!target || !active || !mpRightChat() || window.__mp_baseUrl !== undefined) return;
    const ctx = getContext();
    let msgId = null;
    try { msgId = streamingProcessor?.messageId; } catch (_) {}
    if (msgId == null) msgId = ctx.chat.length - 1;
    const msg = ctx?.chat?.[msgId];
    if (!msg) return;
    postOp({ op: 'update', target, content: msg.mes || '' }).catch(() => {});
}

// ui

async function addSettingsUI() {
    const container = document.getElementById('mp_container') ?? document.getElementById('extensions_settings2');
    if (!container) return;
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $(container).append(html);

    const settings = getSettings();
    $('#mp_code').val(settings.sessionCode);
    $('#mp_host_url').val(settings.hostUrl);
    $('#mp_destroy').prop('disabled', true);
    $('#mp_disconnect').prop('disabled', true);

    $('#mp_code').on('change', function () { settings.sessionCode = String($(this).val()); saveSettingsDebounced(); });
    $('#mp_host_url').on('change', function () { settings.hostUrl = String($(this).val()); saveSettingsDebounced(); });
    $('#mp_create').on('click', createRoom);
    $('#mp_destroy').on('click', destroyRoom);
    $('#mp_connect').on('click', connectToHost);
    $('#mp_disconnect').on('click', disconnectFromHost);

    // capture phase: run before st handlers
    document.addEventListener('click', onCaptureClick, true);
    document.addEventListener('keydown', onCaptureKeydown, true);
    ensureHudTypingEl();
    attachTypingInputListener();
}

// same set style.css dims in client mode
const MP_BLOCKED_GENERATION = [
    '#option_regenerate', '#option_continue', '#option_impersonate', '#option_new_bookmark',
    '#option_convert_to_group', '#option_start_new_chat', '#option_close_chat', '#option_select_chat',
    '#option_delete_mes', '#option_back_to_main', '#options_button', '#mes_continue',
    '#mes_impersonate', '.swipe_left', '.swipe_right', '.mes_img_swipe_left', '.mes_img_swipe_right',
];
const MP_BLOCK_GEN_SELECTOR = MP_BLOCKED_GENERATION.join(', ');

function mpClientActive() {
    return active && myUserId !== null && window.__mp_baseUrl !== undefined && window.__mp_baseUrl !== null;
}

// room is bound to the chat it was opened with
function mpRightChat() {
    if (!active) return true;
    if (window.__mp_chatId === undefined) return true; // unlocked (compat)
    return (getContext()?.chatId || null) === window.__mp_chatId;
}

function onChatChanged() {
    refreshKnownIds();
    if (!active) return;
    if (!mpRightChat()) {
        setStatus('warn', 'Paused — open the room chat to continue');
        toastr.warning('Room paused: you are not in the shared chat. Go back to it to continue.', 'Multiplayer');
    } else {
        const code = window.__mp_baseUrl ? window.__mp_code : getSettings().sessionCode;
        setStatus('ok', window.__mp_baseUrl ? `Connected — room ${code}` : `Host — room ${code}`);
    }
}

function onCaptureClick(e) {
    if (!mpClientActive()) return;
    if (e.target?.closest?.('#send_but')) {
        e.preventDefault();
        e.stopPropagation();
        void sendClientText();
        return;
    }
    // message buttons: edit/confirm/cancel/delete only on own messages
    if (e.target?.closest?.('.mes_buttons, .mes_edit_buttons')) {
        const mesId = Number(e.target.closest('.mes')?.getAttribute('mesid'));
        const msg = getContext()?.chat?.[mesId];
        const isOwn = !!msg && msg.extra?.mpUserId === myUserId;
        const action = e.target.closest('.mes_edit, .mes_edit_done, .mes_edit_cancel, .mes_edit_delete');
        if (!isOwn || !action) {
            e.preventDefault();
            e.stopPropagation();
            blockMessageActionNotice();
            return;
        }
        if (action.classList.contains('mes_edit')) {
            // open the editor ourselves: st's delegated pencil handler dies on
            // stale edit state (remote deletes renumber mesid under it)
            e.preventDefault();
            e.stopPropagation();
            void messageEdit(mesId);
            return;
        }
        return;
    }
    if (e.target?.closest?.(MP_BLOCK_GEN_SELECTOR)) {
        e.preventDefault();
        e.stopPropagation();
        blockGenerationNotice();
    }
}

let lastMessageActionToast = 0;

function blockMessageActionNotice() {
    const now = Date.now();
    if (now - lastMessageActionToast > MP_BLOCK_TOAST_MS) {
        lastMessageActionToast = now;
        toastr.info('You can only edit or delete your own messages.', 'Multiplayer');
    }
}

function blockGenerationNotice() {
    const now = Date.now();
    if (now - lastBlockToast > MP_BLOCK_TOAST_MS) {
        lastBlockToast = now;
        toastr.info('Generation blocked: connected as client. Only the host generates replies.', 'Multiplayer');
    }
}

function onBlockGeneration() {
    // catch stray generation from hotkeys or other extensions
    if (!mpClientActive()) return;
    try { stopGeneration(); } catch (_) { }
    blockGenerationNotice();
}

function onCaptureKeydown(e) {
    if (!mpClientActive()) return;
    if (e.key === 'Enter' && !e.shiftKey && e.target?.closest?.('#send_textarea')) {
        e.preventDefault();
        e.stopPropagation();
        void sendClientText();
        return;
    }
    // st uses arrows for swipes / new variant, but not while typing
    const typingInField = e.target?.closest?.('textarea, input');
    if (!typingInField && !e.ctrlKey && !e.altKey && !e.metaKey
        && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        blockGenerationNotice();
    }
}

async function sendClientText() {
    const sendTextarea = document.getElementById('send_textarea');
    const text = String(sendTextarea ? sendTextarea.value : $('#send_textarea').val()).trim();
    if (!text) return;
    if (sendTextarea) { sendTextarea.value = ''; sendTextarea.dispatchEvent(new Event('input', { bubbles: true })); }
    else { $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true })); }
    cutTypingNotice();
    const persona = getMyPersona();
    let avatar = await avatarToDataUrl('persona', user_avatar);
    if (!avatar && avatarMemory[myUserId]) avatar = avatarMemory[myUserId];
    if (avatar) avatarMemory[myUserId] = avatar;
    // unique order per message or dedup eats them
    orderCounter++;
    const myOrder = orderCounter;
    const nowTs = Date.now();
    await apiPost(`${window.__mp_baseUrl}/api/plugins/multiplayer/msg`, {
        code: window.__mp_code, userId: myUserId, token: myToken, name: persona.name, content: text, avatar, order: myOrder, ts: nowTs,
    });
    const ctx = getContext();
    if (!ctx || !ctx.chat) return;
    const msg = { name: persona.name, mes: text, is_user: true, character_name: persona.name, force_avatar: avatar, extra: { fromMultiplayer: true, mpMsgId: `${myUserId}_${myOrder}`, mpUserId: myUserId, mpOrder: myOrder, mpTs: nowTs } };
    ctx.chat.push(msg);
    ctx.addOneMessage(msg, { type: 'user' });
    if (ctx.scrollChatToBottom) ctx.scrollChatToBottom();
    refreshKnownIds();
}

jQuery(async () => {
    console.log(`[Multiplayer] Extension v${MP_VERSION} cargada — creado por ${MP_AUTHOR}`);
    loadSettings();
    await addSettingsUI();
});
