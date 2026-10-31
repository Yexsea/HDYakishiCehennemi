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

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 20000,
    pingInterval: 10000,
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

// Başkan sistemi: odanın başkanı (isimle tutulur, socket id yeniden bağlanınca değişir)
const roomLeader = {};
// Başkanın en son açtığı video sayfası
const roomLeaderUrl = {};
// Sayfa yenilenen/değişen kullanıcılar için bekleme süresi (ms)
const LEAVE_GRACE_MS = 15000;
// Bekleyen çıkış zamanlayıcıları: key = roomId + '\u0000' + userName
const pendingLeaves = {};

function leaveKey(roomId, userName) {
    return roomId + '\u0000' + userName;
}

function isUserInRoom(roomId, userName) {
    return Object.values(activeUsers).some(u => u.room === roomId && u.name === userName);
}

function ensureLeader(roomId, userName) {
    if (!roomLeader[roomId]) roomLeader[roomId] = userName;
}

io.on('connection', (socket) => {

    socket.on('join-room', ({ roomId, userName }) => {
        for (const [id, user] of Object.entries(activeUsers)) {
            if (user.name === userName && user.room === roomId) delete activeUsers[id];
        }

        // Bekleme süresi içinde geri döndüyse (sayfa yenileme/değiştirme) sessizce devam et
        const key = leaveKey(roomId, userName);
        const isRejoin = !!pendingLeaves[key];
        if (isRejoin) {
            clearTimeout(pendingLeaves[key]);
            delete pendingLeaves[key];
        }

        socket.join(roomId);
        activeUsers[socket.id] = {
            name: userName,
            room: roomId,
            color: getRandomColor(),
            lastPingAt: Date.now(),
            slowConnection: false
        };

        ensureLeader(roomId, userName);

        // Özellik 4: Mesaj geçmişini gönder (yeni kullanıcıya)
        if (roomMessageHistory[roomId] && roomMessageHistory[roomId].length > 0) {
            socket.emit('message-history', roomMessageHistory[roomId]);
        }

        // Özellik 1: Catch-up sync — mevcut oynatma durumunu gönder
        if (roomPlayState[roomId]) {
            socket.emit('catch-up-sync', roomPlayState[roomId]);
        }

        // Başkanın açtığı son videoyu yeni gelene de bildir
        if (roomLeaderUrl[roomId] && roomLeader[roomId] !== userName) {
            socket.emit('leader-navigated', { url: roomLeaderUrl[roomId], leaderName: roomLeader[roomId], onJoin: true });
        }

        if (!isRejoin) {
            const joinMsg = { sender: 'Sistem', text: `${userName} odaya katıldı.`, isSystem: true };
            io.to(roomId).emit('receive-message', joinMsg);

            // Özellik 4: Sistem mesajını da geçmişe ekle
            addToHistory(roomId, joinMsg);
        }

        updateUserList(roomId);
    });

    // Başkan yeni bir video sayfası açtı → odadaki herkese bildir
    socket.on('leader-navigate', ({ roomId, url }) => {
        const user = activeUsers[socket.id];
        if (!user || user.room !== roomId || roomLeader[roomId] !== user.name) return;
        if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) return;
        if (normalizeUrl(roomLeaderUrl[roomId]) === normalizeUrl(url)) return;

        roomLeaderUrl[roomId] = url;
        // Yeni video: eski oynatma durumu ve süre artık geçersiz
        delete roomPlayState[roomId];
        delete roomDurations[roomId];

        socket.to(roomId).emit('leader-navigated', { url, leaderName: user.name });
    });

    // Başkan başkanlığı başka birine devrediyor
    socket.on('transfer-leader', ({ roomId, targetName }) => {
        const user = activeUsers[socket.id];
        if (!user || user.room !== roomId || roomLeader[roomId] !== user.name) return;
        if (!targetName || targetName === user.name || !isUserInRoom(roomId, targetName)) return;

        roomLeader[roomId] = targetName;
        const msg = { sender: 'Sistem', text: `👑 ${user.name}, başkanlığı ${targetName} kişisine devretti.`, isSystem: true };
        io.to(roomId).emit('receive-message', msg);
        addToHistory(roomId, msg);
        updateUserList(roomId);
    });

    socket.on('mouse-move', (data) => {
        if (data.color && activeUsers[socket.id]) {
            activeUsers[socket.id].color = data.color;
        }
        socket.to(data.roomId).emit('mouse-update', {
            id: socket.id,
            x: data.x,
            y: data.y,
            name: activeUsers[socket.id]?.name || '?',
            color: activeUsers[socket.id]?.color || '#ff0000'
        });
    });

    socket.on('draw-line', (data) => {
        socket.to(data.roomId).emit('draw-line', data);
    });

    socket.on('send-reaction', (data) => {
        socket.to(data.roomId).emit('show-reaction', data.type);
    });

    socket.on('typing-start', (roomId) => {
        const user = activeUsers[socket.id];
        if (user) socket.to(roomId).emit('user-typing', { user: user.name, isTyping: true });
    });

    socket.on('typing-stop', (roomId) => {
        const user = activeUsers[socket.id];
        if (user) socket.to(roomId).emit('user-typing', { user: user.name, isTyping: false });
    });

    socket.on('video-duration', ({ roomId, duration }) => {
        if (!roomDurations[roomId]) {
            roomDurations[roomId] = duration;
        } else {
            const diff = Math.abs(roomDurations[roomId] - duration);
            if (diff > 5) {
                socket.emit('duration-error', { serverDuration: roomDurations[roomId], yourDuration: duration });
            }
        }
    });

    socket.on('page-url', ({ roomId, url }) => {
        if (activeUsers[socket.id]) {
            activeUsers[socket.id].url = url;
        }
        const otherUsers = Object.entries(activeUsers)
            .filter(([id, u]) => u.room === roomId && id !== socket.id && u.url);

        const mismatch = otherUsers.filter(([id, u]) => normalizeUrl(u.url) !== normalizeUrl(url));
        if (mismatch.length > 0) {
            socket.emit('url-mismatch', {
                yourUrl: url,
                others: mismatch.map(([id, u]) => ({ name: u.name, url: u.url }))
            });
            mismatch.forEach(([id, u]) => {
                io.to(id).emit('url-mismatch', {
                    yourUrl: u.url,
                    others: [{ name: activeUsers[socket.id]?.name, url: url }]
                });
            });
        }
    });

    socket.on('sync-action', (data) => {
        socket.to(data.roomId).emit('sync-update', data);

        // Özellik 1: Odanın oynatma durumunu güncelle
        if (!roomPlayState[data.roomId]) roomPlayState[data.roomId] = {};
        roomPlayState[data.roomId].time = data.time;
        roomPlayState[data.roomId].type = data.type;
        roomPlayState[data.roomId].updatedAt = Date.now();
    });

    socket.on('send-message', (data) => {
        socket.to(data.roomId).emit('receive-message', data);
        // Özellik 4: Mesajı geçmişe ekle
        addToHistory(data.roomId, data);
    });

    // Özellik 6: Ping ölçümü — client ping attığında timestamp kaydedilir
    socket.on('client-ping', (data) => {
        socket.emit('client-pong', { t: data.t });
        if (activeUsers[socket.id]) {
            activeUsers[socket.id].lastPingAt = Date.now();
        }
    });

    socket.on('heartbeat', (data) => {
        if (!activeUsers[socket.id] && data.roomId && data.userName) {
            socket.join(data.roomId);
            activeUsers[socket.id] = {
                name: data.userName,
                room: data.roomId,
                color: getRandomColor(),
                lastPingAt: Date.now(),
                slowConnection: false
            };
            const key = leaveKey(data.roomId, data.userName);
            if (pendingLeaves[key]) {
                clearTimeout(pendingLeaves[key]);
                delete pendingLeaves[key];
            }
            ensureLeader(data.roomId, data.userName);
            updateUserList(data.roomId);
        } else if (activeUsers[socket.id]) {
            activeUsers[socket.id].lastPingAt = Date.now();
        }
    });

    socket.on('report-latency', ({ roomId, latency }) => {
        if (!activeUsers[socket.id]) return;
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
            const roomId = user.room;
            const userName = user.name;
            io.to(roomId).emit('remove-cursor', { id: socket.id });
            delete activeUsers[socket.id];
            updateUserList(roomId);

            // Aynı isimle başka bağlantısı hâlâ varsa hiçbir şey yapma
            if (isUserInRoom(roomId, userName)) return;

            // Sayfa yenileme/değiştirme olabilir: hemen "düştü" deme, biraz bekle
            const key = leaveKey(roomId, userName);
            if (pendingLeaves[key]) clearTimeout(pendingLeaves[key]);
            pendingLeaves[key] = setTimeout(() => {
                delete pendingLeaves[key];
                if (isUserInRoom(roomId, userName)) return;

                console.log(`[ÇIKIŞ] ${userName}`);
                const remaining = Object.values(activeUsers).filter(u => u.room === roomId);

                if (remaining.length === 0) {
                    delete roomDurations[roomId];
                    delete roomPlayState[roomId];
                    delete roomMessageHistory[roomId];
                    delete roomLeader[roomId];
                    delete roomLeaderUrl[roomId];
                    return;
                }

                io.to(roomId).emit('receive-message', {
                    sender: 'Sistem',
                    text: `${userName} düştü! Video durduruluyor.`,
                    isSystem: true
                });
                io.to(roomId).emit('emergency-pause', { userName });

                // Başkan gittiyse odada kalan ilk kişi başkan olur
                if (roomLeader[roomId] === userName) {
                    roomLeader[roomId] = remaining[0].name;
                    const msg = { sender: 'Sistem', text: `👑 Yeni başkan: ${remaining[0].name}`, isSystem: true };
                    io.to(roomId).emit('receive-message', msg);
                    addToHistory(roomId, msg);
                }
                updateUserList(roomId);
            }, LEAVE_GRACE_MS);
        }
    });
});

function updateUserList(roomId) {
    const uniqueUsers = {};
    for (const [id, info] of Object.entries(activeUsers)) {
        if (info.room === roomId) {
            uniqueUsers[info.name] = uniqueUsers[info.name] || { name: info.name, slowConnection: false, isLeader: roomLeader[roomId] === info.name };
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

function normalizeUrl(u) {
    if (!u) return '';
    try {
        let obj = new URL(u);
        let host = obj.hostname.replace(/^www\./, '');
        let path = obj.pathname.replace(/\/$/, '');
        let params = new URLSearchParams(obj.search);
        ['fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'ref', 'gclid'].forEach(k => params.delete(k));
        let search = params.toString();
        return host + path + (search ? '?' + search : '');
    } catch (e) { return u; }
}

function getRandomColor() {
    return `hsl(${Math.random() * 360}, 100%, 60%)`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda hazır.`);
});