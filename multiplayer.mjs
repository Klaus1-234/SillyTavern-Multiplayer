// mp server plugin: rooms live in memory, identity = server-issued token
import crypto from 'node:crypto';

const PLUGIN_VERSION = '1.7.10';
const PLUGIN_AUTHOR = 'klaus.1234.';
const ROOM_TIMEOUT = 12 * 60 * 60 * 1000;
const MAX_ROOMS = 100;
const MAX_MSGS = 500;
const CLOSED_ROOM_TTL_MS = 60000;
const SWEEP_INTERVAL_MS = 60000;
const TYPING_LIVE_MS = 3000;
const JOIN_NOTICE_WINDOW_MS = 5 * 60000;
const MAX_SWIPES = 100;
const MAX_SWIPE_ID = 999;
// 6-64 chars, keeps brute force annoying
const CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;
// host alive = room not stealable; window for a legit host to reclaim after a crash
const HOST_TAKEOVER_MS = 5 * 60000;

// mirror of MP_* on the client, server always re-checks
const LIMITS = { userId: 100, name: 200, content: 200000, avatar: 700000, personaDesc: 8000, target: 200 };

const rooms = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (room.closed && now - (room.closedAt || now) > CLOSED_ROOM_TTL_MS) { rooms.delete(code); continue; }
        if (room.clients.size === 0 && now - room.lastActivity > ROOM_TIMEOUT) rooms.delete(code);
    }
}, SWEEP_INTERVAL_MS);

function getRoom(code) {
    if (!code) return null;
    if (!rooms.has(code)) rooms.set(code, { code, clients: new Map(), messages: [], lastActivity: Date.now() });
    rooms.get(code).lastActivity = Date.now();
    return rooms.get(code);
}

// peek never resurrects a closed room
function peekRoom(code) {
    if (!code) return null;
    return rooms.get(code) || null;
}

function clampStr(v, max) {
    if (typeof v !== 'string') return '';
    return v.length > max ? v.slice(0, max) : v;
}

// names end up in system messages / html: no <>&"'
function cleanStr(v, max) {
    return clampStr(v, max).replace(/[<>&"']/g, '');
}

// data:image only, no traceable remote urls
function safeAvatar(v) {
    if (typeof v !== 'string' || !v) return '';
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(v)) return '';
    return v.length <= LIMITS.avatar ? v : '';
}

function sanitizePersona(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const raw = p.description;
    const description = typeof raw === 'string' ? raw : (raw?.description || '');
    return {
        name: cleanStr(p.name, LIMITS.name),
        description: clampStr(description, LIMITS.personaDesc),
    };
}

function sanitizeMessage(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const userId = cleanStr(m.userId, LIMITS.userId);
    if (!userId || userId.startsWith('__')) return null;
    return {
        userId,
        name: cleanStr(m.name, LIMITS.name) || 'Someone',
        content: clampStr(m.content, LIMITS.content),
        avatar: safeAvatar(m.avatar),
        order: Number.isFinite(m.order) ? m.order : null,
        ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
    };
}

function sanitizeSwipes(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, MAX_SWIPES).map(s => clampStr(typeof s === 'string' ? s : String(s ?? ''), LIMITS.content));
}

// flat objects with primitive values only, st iterates this
function sanitizeSwipeInfo(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, MAX_SWIPES).map(info => {
        if (info === null || typeof info !== 'object' || Array.isArray(info)) return {};
        const out = {};
        for (const [k, v] of Object.entries(info)) {
            const cleanKey = String(k).slice(0, 64).replace(/[<>&"']/g, '');
            if (!cleanKey) continue;
            if (typeof v === 'string') out[cleanKey] = clampStr(v, 200);
            else if (typeof v === 'number' || typeof v === 'boolean') out[cleanKey] = v;
        }
        return out;
    });
}

// code opens the door, token proves identity
function checkAuth(room, userId, token) {
    if (!room || !room.auth) return false;
    if (typeof userId !== 'string' || typeof token !== 'string') return false;
    const expected = room.auth.get(userId);
    if (!expected || expected.length !== token.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
    } catch { return false; }
}

function noteHost(room, userId) {
    if (room && userId === room.hostId) room.lastHostSeen = Date.now();
}

// token via X-MP-Token header (client channel), query kept for compat
function headerToken(req) {
    try {
        const viaGet = typeof req.get === 'function' ? req.get('x-mp-token') : null;
        if (typeof viaGet === 'string' && viaGet) return viaGet;
        const viaHeaders = req.headers?.['x-mp-token'];
        return typeof viaHeaders === 'string' ? viaHeaders : '';
    } catch { return ''; }
}

// burst 120, refill 12/s: enough for streaming ticks
const RATE_BURST = 120;
const RATE_REFILL_PER_MS = 12 / 1000;
function hitRate(room, userId) {
    const now = Date.now();
    if (!room.rate) room.rate = new Map();
    let bucket = room.rate.get(userId);
    if (!bucket) { bucket = { tokens: RATE_BURST, last: now }; room.rate.set(userId, bucket); }
    bucket.tokens = Math.min(RATE_BURST, bucket.tokens + (now - bucket.last) * RATE_REFILL_PER_MS);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
}

function pushMsg(room, entry) {
    room.messages.push(entry);
    if (room.messages.length > MAX_MSGS) room.messages.shift();
}

async function init(router) {
    router.use((await import('cors')).default());
    console.log(`[Multiplayer] Plugin v${PLUGIN_VERSION} montado en /api/plugins/multiplayer`);

    router.post('/init', (req, res) => {
        const { code } = req.body || {};
        if (typeof code !== 'string' || !CODE_RE.test(code)) {
            return res.status(400).json({ error: 'invalid code (6-64 chars: A-Z a-z 0-9 _ -)' });
        }
        // live room with an alive host can't be re-inited without its token
        const existing = rooms.get(code);
        if (existing && !existing.closed && existing.hostId && existing.auth?.has(existing.hostId)) {
            const hostAlive = Date.now() - (existing.lastHostSeen || 0) < HOST_TAKEOVER_MS;
            if (hostAlive && !checkAuth(existing, req.body?.userId, req.body?.token)) {
                return res.status(403).json({ error: 'room already active' });
            }
        }
        if (!existing && rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'server full' });

        const room = getRoom(code);
        // random ids, not derivable from the code
        const hostId = crypto.randomBytes(16).toString('hex');
        const token = crypto.randomBytes(24).toString('hex');
        room.host = sanitizePersona(req.body?.host);
        room.lastActivity = Date.now();
        room.lastHostSeen = Date.now();
        room.messages = [];
        room.closed = false;
        room.closedAt = null;
        room.clients = new Map();
        room.lastTyping = null;
        room.typings = new Map();
        room.auth = new Map([[hostId, token]]);
        room.rate = new Map();
        room.hostId = hostId;
        return res.json({ ok: true, hostId, token, host: room.host });
    });

    router.post('/join', (req, res) => {
        const { code, userId } = req.body || {};
        if (typeof userId !== 'string' || !userId || userId.length > LIMITS.userId || userId.startsWith('__')) {
            return res.status(400).json({ error: 'invalid userId' });
        }
        const room = peekRoom(code);
        if (!room || room.closed || !room.auth) return res.status(404).json({ error: 'room not found' });

        const persona = sanitizePersona(req.body?.persona);
        const alreadyHere = room.clients.has(userId);
        const token = crypto.randomBytes(24).toString('hex');
        room.clients.set(userId, { userId, persona, joinedAt: Date.now() });
        room.auth.set(userId, token);
        room.lastActivity = Date.now();
        const joinText = `${persona.name || 'Someone'} joined the game.`;
        const recent = room.messages.slice(-5);
        const isDupJoin = alreadyHere && recent.some(m => m.userId === '__system' && m.content === joinText && (Date.now() - m.ts) < JOIN_NOTICE_WINDOW_MS);
        if (!isDupJoin) pushMsg(room, { userId: '__system', name: 'System', content: joinText, ts: Date.now() });
        return res.json({ ok: true, token, host: room.host, users: [...room.clients.values()].map(c => ({ userId: c.userId, persona: c.persona })) });
    });

    router.post('/leave', (req, res) => {
        const { code, userId, token, name } = req.body || {};
        if (!code || !userId) return res.status(400).json({ error: 'code and userId required' });
        const room = peekRoom(code);
        if (!room) return res.json({ ok: true });
        // only the owner leaves as itself, no forced ejections
        if (!checkAuth(room, userId, token)) return res.status(403).json({ error: 'unauthorized' });
        room.clients.delete(userId);
        room.auth.delete(userId);
        pushMsg(room, { userId: '__system', name: 'System', content: `${cleanStr(name, LIMITS.name) || 'Someone'} left the game.`, ts: Date.now() });
        room.lastActivity = Date.now();
        return res.json({ ok: true });
    });

    router.post('/destroy', (req, res) => {
        const { code, userId, token } = req.body || {};
        if (!code || !userId) return res.status(400).json({ error: 'code and userId required' });
        const room = peekRoom(code);
        if (!room) return res.json({ ok: true });
        if (userId !== room.hostId || !checkAuth(room, userId, token)) {
            return res.status(403).json({ error: 'only host can destroy' });
        }
        room.closed = true;
        room.closedAt = Date.now();
        room.lastActivity = Date.now();
        return res.json({ ok: true });
    });

    router.post('/msg', (req, res) => {
        const { code, userId, token, content, name, typing, avatar, order, op, target } = req.body || {};
        if (!code || !userId) return res.status(400).json({ error: 'code and userId required' });
        const room = peekRoom(code);
        if (!room || room.closed) return res.status(404).json({ error: 'room not found' });
        // each token posts as its own userId; exception: the host token may
        // post as a character (userId = character name, no auth entry), since
        // the host generates the ai replies. nobody posts as '__*'.
        const isSelf = checkAuth(room, userId, token);
        const isHostToken = room.hostId ? checkAuth(room, room.hostId, token) : false;
        const actingAsCharacter = !isSelf && isHostToken && !String(userId).startsWith('__');
        if (!isSelf && !actingAsCharacter) return res.status(403).json({ error: 'unauthorized' });
        noteHost(room, actingAsCharacter ? room.hostId : userId);
        if (!hitRate(room, userId)) return res.status(429).json({ error: 'rate limited' });

        // ops travel as buffer entries like messages; swipes must keep
        // op/target/swipes or clients render them as ghost "Alguien" texts
        if (op === 'delete' || op === 'update' || op === 'swipe') {
            const tgt = clampStr(target, LIMITS.target);
            if (!tgt) return res.json({ ok: true });
            // clients may only op their own messages, host ops anything
            if (userId !== room.hostId && !actingAsCharacter) {
                const original = room.messages.find(x => !x.op && `${x.userId}_${x.order ?? x.ts ?? 0}` === tgt);
                if (!original || original.userId !== userId) return res.status(403).json({ error: 'not your message' });
            }
            const entry = { op, target: tgt, userId, name: cleanStr(name, LIMITS.name) || 'Someone', content: clampStr(content, LIMITS.content), ts: Date.now() };
            if (op === 'swipe') {
                entry.swipes = sanitizeSwipes(req.body.swipes);
                entry.swipe_id = Number.isInteger(req.body.swipe_id) ? Math.min(Math.max(req.body.swipe_id, 0), MAX_SWIPE_ID) : 0;
                entry.swipe_info = sanitizeSwipeInfo(req.body.swipe_info);
            }
            pushMsg(room, entry);
        } else if (typeof content === 'string' && content) {
            pushMsg(room, {
                userId,
                name: cleanStr(name, LIMITS.name) || 'Someone',
                content: clampStr(content, LIMITS.content),
                avatar: safeAvatar(avatar),
                order: Number.isFinite(order) ? order : null,
                ts: Date.now(),
            });
        }
        if (typing !== undefined) {
            if (!room.typings) room.typings = new Map();
            const typingName = cleanStr(name, LIMITS.name) || userId;
            const typingAvatar = safeAvatar(avatar);
            if (typing) {
                room.typings.set(userId, { userId, name: typingName, avatar: typingAvatar, typing: true, ts: Date.now() });
                room.lastTyping = { userId, name: typingName, avatar: typingAvatar, typing: true, ts: Date.now() };
            } else {
                room.typings.delete(userId);
                if (room.lastTyping && room.lastTyping.userId === userId) room.lastTyping = null;
            }
        }
        room.lastActivity = Date.now();
        return res.json({ ok: true });
    });

    router.get('/poll', (req, res) => {
        const code = req.query.code;
        const uid = req.query.uid;
        // reading requires membership too, code alone is not enough
        const auth = req.query.auth || headerToken(req);
        if (!code) return res.status(400).json({ error: 'code required' });
        const room = peekRoom(code);
        if (!room || room.closed) return res.json({ ok: false, closed: true });
        if (!checkAuth(room, uid, auth)) return res.status(403).json({ ok: false, error: 'unauthorized' });
        noteHost(room, uid);
        const since = parseInt(req.query.since || '0', 10) || 0;
        const messages = room.messages.filter(m => m.ts > since);
        const users = room.clients.size > 0 ? [...room.clients.values()].map(c => ({ userId: c.userId, persona: c.persona })) : [];
        // typings array + legacy single "typing" field
        let typings = [];
        let typing = null;
        if (room.typings) {
            const now = Date.now();
            for (const [uid2, t] of room.typings) {
                if (now - t.ts > TYPING_LIVE_MS) room.typings.delete(uid2);
                else typings.push(t);
            }
        }
        if (room.lastTyping && Date.now() - room.lastTyping.ts < TYPING_LIVE_MS) typing = room.lastTyping;
        else if (typings.length) typing = typings[0];
        return res.json({ ok: true, messages, users, typing, typings, host: room.host, lastTs: room.messages.length > 0 ? room.messages[room.messages.length - 1].ts : since });
    });

    router.post('/sync', (req, res) => {
        const { code, userId, token, messages, character, host } = req.body || {};
        if (!code) return res.status(400).json({ error: 'code required' });
        const room = peekRoom(code);
        if (!room || room.closed) return res.status(404).json({ error: 'room not found' });
        // only the host rewrites shared history
        if (userId !== room.hostId || !checkAuth(room, userId, token)) {
            return res.status(403).json({ error: 'only host can sync' });
        }
        noteHost(room, userId);
        const h = sanitizePersona(host);
        if (h.name || h.description) room.host = h;
        if (character && typeof character === 'object') {
            room.character = { name: clampStr(character.name, LIMITS.name), avatar: safeAvatar(character.avatar) };
        }
        if (Array.isArray(messages)) {
            room.messages = messages.slice(-MAX_MSGS).map(sanitizeMessage).filter(Boolean);
        }
        room.lastActivity = Date.now();
        return res.json({ ok: true, count: room.messages.length });
    });

    // minimized: no host persona leak, same 404 for valid/invalid codes
    router.get('/info', (req, res) => {
        const code = req.query.code;
        if (typeof code !== 'string' || !CODE_RE.test(code)) return res.status(404).json({ error: 'not found' });
        const room = rooms.get(code);
        if (!room || room.closed) return res.status(404).json({ error: 'not found' });
        return res.json({ ok: true, version: PLUGIN_VERSION, character: room.character ? { name: room.character.name } : null, players: room.clients.size, ping: Date.now() });
    });

    router.post('/kick', (req, res) => {
        const { code, userId, token, target } = req.body || {};
        if (!code || !userId) return res.status(400).json({ error: 'code and userId required' });
        const room = peekRoom(code);
        if (!room) return res.status(404).json({ error: 'room not found' });
        if (userId !== room.hostId || !checkAuth(room, userId, token)) {
            return res.status(403).json({ error: 'only host can kick' });
        }
        const tgt = clampStr(target, LIMITS.userId);
        if (tgt) {
            room.clients.delete(tgt);
            room.auth.delete(tgt);
            if (room.typings) room.typings.delete(tgt);
        }
        room.lastActivity = Date.now();
        return res.json({ ok: true });
    });
}

export const info = {
    id: 'multiplayer',
    name: 'SillyTavern Multiplayer',
    description: 'Share your SillyTavern chat with other players.',
    author: PLUGIN_AUTHOR,
};

export { init };
