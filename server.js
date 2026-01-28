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

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Aktif kullanıcıları takip etmek için hafıza
// Yapı: { socketId: { name: "Ali", room: "Yakishi" } }
const activeUsers = {};

io.on('connection', (socket) => {
    
    // Odaya Katılma
    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        
        // Kullanıcıyı kaydet
        activeUsers[socket.id] = { name: userName, room: roomId };

        console.log(`[GİRİŞ] ${userName} (${roomId}) odaya daldı.`);

        // 1. Odadaki diğerlerine "Sistem Mesajı" gönder (Sohbete düşer)
        io.to(roomId).emit('receive-message', {
            sender: 'Sistem',
            text: `${userName} mekana giriş yaptı.`,
            isSystem: true
        });

        // 2. Odadaki herkese GÜNCEL KULLANICI LİSTESİNİ gönder
        updateUserList(roomId);
    });

    // Video Senkronizasyonu
    socket.on('sync-action', (data) => {
        socket.to(data.roomId).emit('sync-update', data);
    });

    // Sohbet Mesajı
    socket.on('send-message', (data) => {
        // LOGLAMA BURADA (Senin panelinde görünür)
        console.log(`[CHAT - ${data.roomId}] ${data.sender}: ${data.text}`);
        
        // Mesajı herkese gönder
        socket.to(data.roomId).emit('receive-message', data);
    });

    // Bağlantı Kopması
    socket.on('disconnect', () => {
        const user = activeUsers[socket.id];
        
        if (user) {
            console.log(`[ÇIKIŞ] ${user.name} kaçtı.`);
            
            // Kullanıcıyı listeden sil
            delete activeUsers[socket.id];

            // Çıktığını diğerlerine haber ver (Mesaj + Popup)
            io.to(user.room).emit('receive-message', {
                sender: 'Sistem',
                text: `${user.name} mekandan ayrıldı.`,
                isSystem: true
            });

            // Listeyi güncelle
            updateUserList(user.room);
        }
    });
});

// Yardımcı Fonksiyon: Odadaki kullanıcıları bulup listeyi gönderir
function updateUserList(roomId) {
    const usersInRoom = [];
    // activeUsers objesini tarayıp o odadakileri bulalım
    for (const [id, info] of Object.entries(activeUsers)) {
        if (info.room === roomId) {
            usersInRoom.push(info.name);
        }
    }
    io.to(roomId).emit('update-user-list', usersInRoom);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda log tutarak yanıyor...`);
});