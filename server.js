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

    // Video Senkronizasyonu
    socket.on('sync-action', (data) => {
        socket.to(data.roomId).emit('sync-update', data);
    });

    // Mesajlaşma
    socket.on('send-message', (data) => {
        console.log(`[MSG] ${data.sender}: ${data.text}`);
        socket.to(data.roomId).emit('receive-message', data);
    });

    // --- DÜZELTME BURADA: AKILLI KALP ATIŞI ---
    // İstemci her "Ben buradayım" dediğinde listeyi kontrol ediyoruz
    socket.on('heartbeat', (data) => {
        // Eğer kullanıcı bağlı ama listede kaydı yoksa (Sessiz reconnect durumu)
        if (!activeUsers[socket.id] && data.roomId && data.userName) {
            console.log(`[RECOVER] ${data.userName} listeye geri eklendi.`);
            
            // 1. Kullanıcıyı tekrar odaya sok (Socket odası düşmüş olabilir)
            socket.join(data.roomId);
            
            // 2. Listeye kaydet
            activeUsers[socket.id] = { name: data.userName, room: data.roomId };
            
            // 3. Herkese güncel listeyi yolla
            updateUserList(data.roomId);
        }
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
    // Listeyi odaya yayınla
    io.to(roomId).emit('update-user-list', usersInRoom);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda hazır.`);
});