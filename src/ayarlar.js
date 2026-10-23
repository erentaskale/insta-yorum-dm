// Hangi videoda hangi kelime yazılınca ne gönderilecek.
// Yeni video için bir satır ekle, sonra `npm run deploy`.
//
// video: videonun numarası (id). Son videoların numaraları için (PowerShell, $token yüklüyken):
//   (Invoke-RestMethod "https://graph.instagram.com/me/media" -Body @{ fields = "id,timestamp,permalink"; limit = 5; access_token = $token }).data
// kelime: yorumun içinde geçmesi yeter; büyük/küçük harf ve ı/i farkı önemsiz.
// mesaj: DM olarak gidecek yazı.

// Örnek satır:
//   { video: "18372962449208228", kelime: "skill", mesaj: "Selam! 🐱 İşte skill dosyası: <link>" },
export const KAMPANYALAR = [];

// Kendi yorumlarımıza DM atmayalım.
export const HESAP = "yager.dev";
