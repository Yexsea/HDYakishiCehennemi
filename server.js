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

// YENİ: HTTP Kalp Atışı için Endpoint
app.get('/ping', (req, res) => {
    res.send('pong');
});

// Ayarlar: Zaman aşımlarını maksimuma çektik
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
    connectionStateRecovery: {
        // Bağlantı koparsa durumu kurtarmaya çalış (Socket.io v4.6+)
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
    }
});

const activeUsers = {};

io.on('connection', (socket) => {
    
    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        activeUsers[socket.id] = { name: userName, room: roomId };
        console.log(`[GİRİŞ] ${userName} (${roomId})`);

        // Sadece yeni girene değil, odadaki herkese bildir
        io.to(roomId).emit('receive-message', {
            sender: 'Sistem',
            text: `${userName} mekana giriş yaptı.`,
            isSystem: true
        });
        updateUserList(roomId);
    });

    socket.on('sync-action', (data) => {
        socket.to(data.roomId).emit('sync-update', data);
    });

    socket.on('send-message', (data) => {
        console.log(`[CHAT] ${data.sender}: ${data.text}`);
        socket.to(data.roomId).emit('receive-message', data);
    });

    socket.on('keep-alive', () => {
        // Boş cevap
    });

    socket.on('disconnect', (reason) => {
        const user = activeUsers[socket.id];
        console.log(`[KOPMA] ${socket.id} Sebep: ${reason}`);
        
        // Eğer sunucu taraflı bir kopma değilse (kullanıcı kapattıysa) sil
        // Geçici kopmalarda kullanıcıyı hemen silmiyoruz ki geri gelebilsin
        if (reason === "transport close" || reason === "ping timeout") {
             // Bekle, hemen silme (reconnect olabilir)
        }
        
        if (user && reason === "client namespace disconnect") {
            delete activeUsers[socket.id];
            io.to(user.room).emit('receive-message', {
                sender: 'Sistem',
                text: `${user.name} çıktı.`,
                isSystem: true
            });
            updateUserList(user.room);
        }
        
        // Temizlik (Garbage collection için her türlü listeden düşürelim ama bildirim atmayalım)
         if (user) {
             // 5 saniye sonra hala yoksa sil (Basit çözüm)
             setTimeout(() => {
                 const current = activeUsers[socket.id];
                 if(current) { // Hala listedeyse ve tekrar bağlanmadıysa
                     updateUserList(user.room);
                 }
             }, 5000);
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
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda (Anti-Drop Modu) hazır...`);
});