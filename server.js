const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Ana Sayfa
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Render Uyanık Kalsın Diye HTTP Ping Noktası
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000, // 60 saniye tolerans
    pingInterval: 25000 // 25 saniyede bir kontrol
});

const activeUsers = {};

io.on('connection', (socket) => {
    
    // Odaya Giriş
    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        activeUsers[socket.id] = { name: userName, room: roomId };
        console.log(`[GİRİŞ] ${userName} -> ${roomId}`);

        // Odaya bildirim
        io.to(roomId).emit('receive-message', {
            sender: 'Sistem',
            text: `${userName} odaya katıldı.`,
            isSystem: true
        });
        
        // Listeyi güncelle
        updateUserList(roomId);
    });

    // Video Senkronizasyonu (Play/Pause/Seek)
    socket.on('sync-action', (data) => {
        // Gönderen HARİÇ odadaki herkese ilet
        socket.to(data.roomId).emit('sync-update', data);
    });

    // Mesajlaşma
    socket.on('send-message', (data) => {
        console.log(`[MSG] ${data.sender}: ${data.text}`);
        socket.to(data.roomId).emit('receive-message', data);
    });

    // Kalp Atışı (Sadece log kirliliği yapmasın diye boş bırakıyoruz)
    socket.on('heartbeat', () => {
        // Sunucu bu mesajı alınca bağlantıyı canlı sayar.
    });

    // Çıkış
    socket.on('disconnect', () => {
        const user = activeUsers[socket.id];
        if (user) {
            console.log(`[ÇIKIŞ] ${user.name}`);
            delete activeUsers[socket.id];
            
            io.to(user.room).emit('receive-message', {
                sender: 'Sistem',
                text: `${user.name} ayrıldı.`,
                isSystem: true
            });
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