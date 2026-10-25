const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Eklenti her sitede çalıştığı için CORS açık kalmak zorunda.
// Güvenlik, aşağıdaki doğrulama ve oda kurallarıyla sağlanıyor.
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 64 * 1024,          // tek bir mesaj en fazla 64 KB
    pingTimeout: 5000,
    pingInterval: 2000,
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
    }
});

const activeUsers = {};
const roomDurations = {};

// Özellik 4: Her odanın son 50 mesajını sakla
const roomMessageHistory = {};

// Özellik 1: Odanın mevcut oynatma durumunu sakla
const roomPlayState = {};

// ═══════════════════════════════════════
//  GİRDİ DOĞRULAMA
//  İstemciden gelen hiçbir veriye olduğu gibi güvenilmez.
// ═══════════════════════════════════════
const LIMITS = { name: 15, room: 40, text: 500, url: 2048 };
const REACTIONS = new Set(['❤️', '😂', '😲', '👏', '🔥', '🕊️', '🤷']);
const SYNC_TYPES = new Set(['play', 'pause', 'seek']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Metni kırp, kontrol karakterlerini at
function cleanStr(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

// Sonlu bir sayı mı? Değilse null
function num(value) {
    return (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
}

// Bir soketin olayları sadece kendi katıldığı odaya gidebilir.
// İstemcinin gönderdiği roomId'ye bakılmaz.
function roomOf(socket) {
    const user = activeUsers[socket.id];
    return user ? user.room : null;
}

// Basit hız sınırı: her olay türü için saniyede en fazla `perSecond` olay
function allow(socket, kind, perSecond) {
    const now = Date.now();
    if (!socket.data.rate) socket.data.rate = {};
    const r = socket.data.rate[kind] || (socket.data.rate[kind] = { start: now, count: 0 });
    if (now - r.start >= 1000) { r.start = now; r.count = 0; }
    r.count++;
    return r.count <= perSecond;
}

function registerUser(socket, rawName, rawRoom) {
    const name = cleanStr(rawName, LIMITS.name);
    const roomId = cleanStr(rawRoom, LIMITS.room);
    if (!name || !roomId) return null;

    // Aynı soket başka bir odadaysa önce oradan çıkar
    const previous = activeUsers[socket.id];
    if (previous && previous.room !== roomId) {
        socket.leave(previous.room);
        delete activeUsers[socket.id];
        updateUserList(previous.room);
    }

    for (const [id, user] of Object.entries(activeUsers)) {
        if (id !== socket.id && user.name === name && user.room === roomId) delete activeUsers[id];
    }

    socket.join(roomId);
    activeUsers[socket.id] = {
        name: name,
        room: roomId,
        color: getRandomColor(),
        lastPingAt: Date.now(),
        slowConnection: false
    };
    return { name, roomId };
}

io.on('connection', (socket) => {

    socket.on('join-room', (data) => {
        if (!data || !allow(socket, 'join', 3)) return;
        const joined = registerUser(socket, data.userName, data.roomId);
        if (!joined) return;
        const { name, roomId } = joined;

        // Özellik 4: Mesaj geçmişini gönder (yeni kullanıcıya)
        if (roomMessageHistory[roomId] && roomMessageHistory[roomId].length > 0) {
            socket.emit('message-history', roomMessageHistory[roomId]);
        }

        // Özellik 1: Catch-up sync — mevcut oynatma durumunu gönder
        if (roomPlayState[roomId]) {
            socket.emit('catch-up-sync', roomPlayState[roomId]);
        }

        const joinMsg = { sender: 'Sistem', text: `${name} odaya katıldı.`, isSystem: true };
        io.to(roomId).emit('receive-message', joinMsg);

        // Özellik 4: Sistem mesajını da geçmişe ekle
        addToHistory(roomId, joinMsg);

        updateUserList(roomId);
    });

    socket.on('mouse-move', (data) => {
        const room = roomOf(socket);
        if (!room || !data || !allow(socket, 'mouse', 40)) return;
        const x = num(data.x), y = num(data.y);
        if (x === null || y === null) return;
        socket.to(room).emit('mouse-update', {
            id: socket.id,
            x: clamp(x, 0, 100),
            y: clamp(y, 0, 100),
            name: activeUsers[socket.id].name,
            color: activeUsers[socket.id].color
        });
    });

    socket.on('draw-line', (data) => {
        const room = roomOf(socket);
        if (!room || !data || !allow(socket, 'draw', 80)) return;
        const coords = [data.startX, data.startY, data.endX, data.endY].map(num);
        if (coords.some((v) => v === null)) return;
        const [startX, startY, endX, endY] = coords.map((v) => clamp(v, 0, 1));
        const color = (typeof data.color === 'string' && HEX_COLOR.test(data.color)) ? data.color : '#ff80bf';
        socket.to(room).emit('draw-line', { startX, startY, endX, endY, color });
    });

    socket.on('send-reaction', (data) => {
        const room = roomOf(socket);
        if (!room || !data || !allow(socket, 'reaction', 10)) return;
        if (!REACTIONS.has(data.type)) return;
        socket.to(room).emit('show-reaction', data.type);
    });

    socket.on('typing-start', () => {
        const room = roomOf(socket);
        if (!room || !allow(socket, 'typing', 5)) return;
        socket.to(room).emit('user-typing', { user: activeUsers[socket.id].name, isTyping: true });
    });

    socket.on('typing-stop', () => {
        const room = roomOf(socket);
        if (!room || !allow(socket, 'typing', 5)) return;
        socket.to(room).emit('user-typing', { user: activeUsers[socket.id].name, isTyping: false });
    });

    socket.on('video-duration', (data) => {
        const roomId = roomOf(socket);
        if (!roomId || !data) return;
        const duration = num(data.duration);
        if (duration === null || duration <= 0) return;
        if (!roomDurations[roomId]) {
            roomDurations[roomId] = duration;
        } else {
            const diff = Math.abs(roomDurations[roomId] - duration);
            if (diff > 5) {
                socket.emit('duration-error', { serverDuration: roomDurations[roomId], yourDuration: duration });
            }
        }
    });

    socket.on('page-url', (data) => {
        const roomId = roomOf(socket);
        if (!roomId || !data || !allow(socket, 'url', 5)) return;
        const url = cleanStr(data.url, LIMITS.url);
        if (!/^https?:\/\//i.test(url)) return;
        activeUsers[socket.id].url = url;

        const otherUsers = Object.entries(activeUsers)
            .filter(([id, u]) => u.room === roomId && id !== socket.id && u.url);

        const mismatch = otherUsers.filter(([id, u]) => u.url !== url);
        if (mismatch.length > 0) {
            socket.emit('url-mismatch', {
                yourUrl: url,
                others: mismatch.map(([id, u]) => ({ name: u.name, url: u.url }))
            });
            mismatch.forEach(([id, u]) => {
                io.to(id).emit('url-mismatch', {
                    yourUrl: u.url,
                    others: [{ name: activeUsers[socket.id].name, url: url }]
                });
            });
        }
    });

    socket.on('sync-action', (data) => {
        const room = roomOf(socket);
        if (!room || !data || !allow(socket, 'sync', 10)) return;
        const time = num(data.time);
        if (!SYNC_TYPES.has(data.type) || time === null || time < 0) return;

        socket.to(room).emit('sync-update', { roomId: room, type: data.type, time: time });

        // Özellik 1: Odanın oynatma durumunu güncelle
        if (!roomPlayState[room]) roomPlayState[room] = {};
        roomPlayState[room].time = time;
        roomPlayState[room].type = data.type;
        roomPlayState[room].updatedAt = Date.now();
    });

    socket.on('send-message', (data) => {
        const room = roomOf(socket);
        if (!room || !data || !allow(socket, 'chat', 4)) return;
        const text = cleanStr(data.text, LIMITS.text);
        if (!text) return;
        // Gönderen adı istemciden değil, sunucunun kaydından alınır (taklit edilemez)
        const msg = { sender: activeUsers[socket.id].name, text: text };
        socket.to(room).emit('receive-message', msg);
        // Özellik 4: Mesajı geçmişe ekle
        addToHistory(room, msg);
    });

    // Özellik 6: Ping ölçümü — client ping attığında timestamp kaydedilir
    socket.on('client-ping', (data) => {
        if (!data || !allow(socket, 'ping', 5)) return;
        const t = num(data.t);
        if (t !== null) socket.emit('client-pong', { t: t });
        if (activeUsers[socket.id]) {
            activeUsers[socket.id].lastPingAt = Date.now();
        }
    });

    socket.on('heartbeat', (data) => {
        if (!data || !allow(socket, 'heartbeat', 2)) return;
        if (!activeUsers[socket.id]) {
            const joined = registerUser(socket, data.userName, data.roomId);
            if (joined) updateUserList(joined.roomId);
        } else {
            activeUsers[socket.id].lastPingAt = Date.now();
        }
    });

    socket.on('report-latency', (data) => {
        const roomId = roomOf(socket);
        if (!roomId || !data || !allow(socket, 'latency', 2)) return;
        const latency = num(data.latency);
        if (latency === null) return;
        const wasSlow = activeUsers[socket.id].slowConnection;
        // 500ms eşiği
        activeUsers[socket.id].slowConnection = latency > 500;
        // Eşik değişmişse listeyi güncelle
        if (wasSlow !== activeUsers[socket.id].slowConnection) {
            updateUserList(roomId);
        }
    });

    socket.on('disconnect', (reason) => {
        const user = activeUsers[socket.id];
        if (user) {
            console.log(`[ÇIKIŞ] ${user.name}`);
            io.to(user.room).emit('receive-message', {
                sender: 'Sistem',
                text: `${user.name} düştü! Video durduruluyor.`,
                isSystem: true
            });
            io.to(user.room).emit('emergency-pause', { userName: user.name });
            io.to(user.room).emit('remove-cursor', { id: socket.id });
            delete activeUsers[socket.id];
            updateUserList(user.room);
            const usersLeft = Object.values(activeUsers).filter(u => u.room === user.room).length;
            if (usersLeft === 0) {
                delete roomDurations[user.room];
                delete roomPlayState[user.room];
                delete roomMessageHistory[user.room];
            }
        }
    });
});

function updateUserList(roomId) {
    const uniqueUsers = {};
    for (const [id, info] of Object.entries(activeUsers)) {
        if (info.room === roomId) {
            uniqueUsers[info.name] = uniqueUsers[info.name] || { name: info.name, slowConnection: false };
            if (info.slowConnection) uniqueUsers[info.name].slowConnection = true;
        }
    }
    // Özellik 6: slowConnection bayrağını kullanıcı listesiyle gönder
    io.to(roomId).emit('update-user-list', Object.values(uniqueUsers));
}

function addToHistory(roomId, message) {
    if (!roomMessageHistory[roomId]) roomMessageHistory[roomId] = [];
    roomMessageHistory[roomId].push(message);
    // Maksimum 50 mesaj
    if (roomMessageHistory[roomId].length > 50) {
        roomMessageHistory[roomId].shift();
    }
}

function getRandomColor() {
    return `hsl(${Math.floor(Math.random() * 360)}, 100%, 60%)`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda hazır.`);
});
