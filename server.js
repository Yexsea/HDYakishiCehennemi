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

io.on('connection', (socket) => {
    
    socket.on('join-room', ({ roomId, userName }) => {
        for (const [id, user] of Object.entries(activeUsers)) {
            if (user.name === userName && user.room === roomId) delete activeUsers[id];
        }

        socket.join(roomId);
        activeUsers[socket.id] = { name: userName, room: roomId, color: getRandomColor() };
        
        io.to(roomId).emit('receive-message', {
            sender: 'Sistem',
            text: `${userName} odaya katıldı.`,
            isSystem: true
        });
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

    // YENİ: Çizim Verisi
    socket.on('draw-line', (data) => {
        // data: { startX, startY, endX, endY, color, roomId }
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

    socket.on('sync-action', (data) => {
        socket.to(data.roomId).emit('sync-update', data);
    });

    socket.on('send-message', (data) => {
        socket.to(data.roomId).emit('receive-message', data);
    });

    socket.on('heartbeat', (data) => {
        if (!activeUsers[socket.id] && data.roomId && data.userName) {
            socket.join(data.roomId);
            activeUsers[socket.id] = { name: data.userName, room: data.roomId, color: getRandomColor() };
            updateUserList(data.roomId);
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
            if (usersLeft === 0) delete roomDurations[user.room];
        }
    });
});

function updateUserList(roomId) {
    const uniqueNames = new Set();
    for (const [id, info] of Object.entries(activeUsers)) {
        if (info.room === roomId) uniqueNames.add(info.name);
    }
    io.to(roomId).emit('update-user-list', Array.from(uniqueNames));
}

function getRandomColor() {
    return `hsl(${Math.random() * 360}, 100%, 60%)`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda hazır.`);
});