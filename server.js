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

io.on('connection', (socket) => {

    socket.on('join-room', ({ roomId, userName }) => {
        for (const [id, user] of Object.entries(activeUsers)) {
            if (user.name === userName && user.room === roomId) delete activeUsers[id];
        }

        socket.join(roomId);
        activeUsers[socket.id] = {
            name: userName,
            room: roomId,
            color: getRandomColor(),
            lastPingAt: Date.now(),
            slowConnection: false
        };

        // Özellik 4: Mesaj geçmişini gönder (yeni kullanıcıya)
        if (roomMessageHistory[roomId] && roomMessageHistory[roomId].length > 0) {
            socket.emit('message-history', roomMessageHistory[roomId]);
        }

        // Özellik 1: Catch-up sync — mevcut oynatma durumunu gönder
        if (roomPlayState[roomId]) {
            socket.emit('catch-up-sync', roomPlayState[roomId]);
        }

        const joinMsg = { sender: 'Sistem', text: `${userName} odaya katıldı.`, isSystem: true };
        io.to(roomId).emit('receive-message', joinMsg);

        // Özellik 4: Sistem mesajını da geçmişe ekle
        addToHistory(roomId, joinMsg);

        updateUserList(roomId);
    });

    socket.on('mouse-move', (data) => {
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

        const mismatch = otherUsers.filter(([id, u]) => u.url !== url);
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
    return `hsl(${Math.random() * 360}, 100%, 60%)`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda hazır.`);
});