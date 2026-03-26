# 🍿 HD Yakishi Cehennemi - Real-Time Co-Watching Platform

HD Yakishi Cehennemi, farklı cihazlardan bağlanan kullanıcıların aynı anda, sıfıra yakın gecikmeyle ve tamamen senkronize bir şekilde medya içeriklerini izleyebilmesini sağlayan gerçek zamanlı bir platformdur. 

Bu projeyi sevgilimle eş zamanlı olarka bir şeyler izleyebilmek için yazdım 🤍

### 💡 Geliştirme Süreci ve Çözülen Problemler
Normal ekran paylaşımı yerine cihazda yüklü olan dosyayı oynatıp sadece durdurma, oynatma gibi işlevleri sunucu üzerinden ileterek ağ gecikmesi neredeyse sıfıra indirilmiştir.

**Öne Çıkan Mühendislik Çözümleri:**
- **Emergency Pause (Kopma Koruması):** Kullanıcılardan birinin bağlantısı koptuğunda sunucu bunu algılar ve diğer cihazlardaki videoyu anında duraklatarak hikayeden kopmayı engeller.
- **Duration Check (Süre Toleransı):** cihazlardan yüklenen medya dosyalarının sürelerini karşılaştırır. Farklı bir video açıldıysa senkronizasyon kaymasını engellemek için süre farkı uyarısı verir.
- **Real-time Etkileşim:** Video izleme deneyimini bölmeyen, soket tabanlı anlık sohbet, "yazıyor..." gösterimi ve en güzeli ekranda uçan emojiler.

### 🛠️ Teknolojiler ve Mimari
- **Frontend:** HTML5, CSS3, Vanilla JavaScript, FontAwesome
- **Backend:** Node.js, Express.js
- **Gerçek Zamanlı İletişim:** Socket.io (WebSocket)
- **Ağ:** CORS Yönetimi, Room-based Socket İzolasyonu
