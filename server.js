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
    pingTimeout: 60000,
    pingInterval: 25000
});

const activeUsers = {};
// Oda bazlı video sürelerini tutacağız
const roomDurations = {}; 

io.on('connection', (socket) => {
    
    // Odaya Giriş
    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        activeUsers[socket.id] = { name: userName, room: roomId };
        console.log(`[GİRİŞ] ${userName} -> ${roomId}`);

        io.to(roomId).emit('receive-message', {
            sender: 'Sistem',
            text: `${userName} odaya katıldı.`,
            isSystem: true
        });
        
        updateUserList(roomId);
    });

    // 1. EMOJİ YAĞMURU
    socket.on('send-reaction', (data) => {
        // data = { roomId, type: 'heart' }
        socket.to(data.roomId).emit('show-reaction', data.type);
    });

    // 2. YAZIYOR... GÖSTERGESİ
    socket.on('typing-start', (roomId) => {
        const user = activeUsers[socket.id];
        if (user) {
            socket.to(roomId).emit('user-typing', { user: user.name, isTyping: true });
        }
    });

    socket.on('typing-stop', (roomId) => {
        const user = activeUsers[socket.id];
        if (user) {
            socket.to(roomId).emit('user-typing', { user: user.name, isTyping: false });
        }
    });

    // 3. VİDEO SÜRE KONTROLÜ (GÜVENLİK)
    socket.on('video-duration', ({ roomId, duration }) => {
        // Eğer odada kayıtlı bir süre yoksa ilk gelen kişinin süresini baz al
        if (!roomDurations[roomId]) {
            roomDurations[roomId] = duration;
        } else {
            // Kayıtlı süre ile karşılaştır (2 saniye tolerans tanı)
            const diff = Math.abs(roomDurations[roomId] - duration);
            if (diff > 2) {
                // Sadece hatayı yapan kişiye uyarı gönder
                socket.emit('duration-error', { 
                    serverDuration: roomDurations[roomId], 
                    yourDuration: duration 
                });
            }
        }
    });

    // Senkronizasyon
    socket.on('sync-action', (data) => {
        socket.to(data.roomId).emit('sync-update', data);
    });

    // Mesajlaşma
    socket.on('send-message', (data) => {
        console.log(`[MSG] ${data.sender}: ${data.text}`);
        socket.to(data.roomId).emit('receive-message', data);
    });

    // Kalp Atışı (Liste Kurtarma)
    socket.on('heartbeat', (data) => {
        if (!activeUsers[socket.id] && data.roomId && data.userName) {
            console.log(`[RECOVER] ${data.userName} listeye geri eklendi.`);
            socket.join(data.roomId);
            activeUsers[socket.id] = { name: data.userName, room: data.roomId };
            updateUserList(data.roomId);
        }
    });

    // Çıkış
    socket.on('disconnect', () => {
        const user = activeUsers[socket.id];
        if (user) {
            delete activeUsers[socket.id];
            
            io.to(user.room).emit('receive-message', {
                sender: 'Sistem',
                text: `${user.name} ayrıldı.`,
                isSystem: true
            });
            
            // Eğer odada kimse kalmadıysa süre bilgisini sıfırla
            const usersLeft = Object.values(activeUsers).filter(u => u.room === user.room).length;
            if (usersLeft === 0) {
                delete roomDurations[user.room];
            }

            updateUserList(user.room);
        }
    });
});

function updateUserList(roomId) {
    const usersInRoom = [];
    for (const [id, info] of Object.entries(activeUsers)) {
        if (info.room === roomId) usersInRoom.push(info.name);
    }
    io.to(roomId).emit('update-user-list', usersInRoom);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda hazır.`);
});