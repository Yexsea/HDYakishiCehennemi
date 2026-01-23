const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Güvenlik ve Dosya Yolu Ayarları
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO Ayarları (Bağlantı Yöneticisi)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log(`Biri düştü cehenneme: ${socket.id}`);

    // Odaya Katılma
    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        
        // Odadaki diğerlerine haber ver
        socket.to(roomId).emit('notification', {
            title: 'Yeni Kurban',
            message: `${userName} mekana giriş yaptı.`
        });
    });

    // Video Senkronizasyonu (Play, Pause, İleri Sar)
    socket.on('sync-action', (data) => {
        // Gelen komutu (data) odadaki herkese yay (gönderen hariç)
        socket.to(data.roomId).emit('sync-update', data);
    });

    // Sohbet Mesajı
    socket.on('send-message', (data) => {
        socket.to(data.roomId).emit('receive-message', data);
    });

    // Bağlantı Kopması
    socket.on('disconnect', () => {
        console.log('Biri kaçtı...');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 HDYakishiCehennemi ${PORT} portunda yanıyor...`);
});