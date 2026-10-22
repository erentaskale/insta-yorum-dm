# insta-yorum-dm

`@yager.dev` reels'lerine anahtar kelime yazan kişiye otomatik DM gönderen kendi sistemimiz.
Ücretsiz, marka yazısı yok. Hazır araçların (LinkDM vb.) yerine geçer; portföy projesi.

Bu dosya projenin ortak hafızası: bu klasörde açılan her oturum önce bunu okur. Karar ya da durum değişince burası güncellenir.

## Nasıl çalışır
- Cloudflare Worker (`src/index.js`) cron ile **her dakika** çalışır.
- Tek istekte son 5 videoyu, her birinin son 50 yorumuyla alır.
- `src/ayarlar.js`'deki video + kelime eşleşirse yorum yapana private reply (DM) atar.
- KV (`KAYIT`): video başına DM atılan yorum numaraları; aynı yoruma ikinci DM gitmez. 30 günde silinir.
- Geçici hatada (429/5xx) en fazla 3 deneme; Instagram kalıcı hatayı da 500 döndürebiliyor.

## Komutlar (proje klasöründe, PowerShell)
- Yeni video/kelime: `src/ayarlar.js`'ye satır ekle → `npm run deploy`
- Canlı log: `npm run loglar`
- Kod değişince: `npm run deploy` (bilgisayardaki kod Cloudflare'e ancak böyle gider)
- Token'ı Cloudflare'e yükle: `Get-Content "$env:USERPROFILE\OneDrive\Masaüstü\ig-token.txt" -Raw | npx wrangler secret put IG_TOKEN`

## Kararlar (21-22 Ekim 2026)
- **Webhook yok, polling var:** `comments` webhook'u Advanced Access (App Review + Business Verification) istiyor.
  Polling için Standard Access yeter. DM en geç ~1 dk gecikir.
- **Meta uygulaması:** `yager-dm`, kullanım alanı "Manage messaging & content on Instagram", işletme portföyü yok,
  `yager.dev` Instagram Tester. Yol: Instagram API with Instagram Login (`graph.instagram.com`).
- **Uygulama yayında (Published) olmalı:** Unpublished iken API yalnız rolü olanların yorumlarını döndürüyor.
  Yayına almak için yalnız gizlilik linki istendi (`PRIVACY.md`), App Review gerekmedi.
- **Limitler:** Meta uygulama başına saatte ~200 istek (200 × kullanıcı; kullanıcı = 1). Polling saatte 60 kullanır.
  Private reply: yorum başına 1, yorumdan sonra en fazla 7 gün. Cloudflare ücretsiz: günde 100.000 çalışma, KV günde 1.000 yazma.
- **Kelime eşleşmesi:** büyük/küçük harf, ı/i, İ farkı yok; kelimenin yorumda geçmesi yeter.
- **Takip şartı:** Eren için "blöf" yeterli; gerçek kontrol (Faz 5) isteğe bağlı.
- **workers.dev:** Worker dışarıya kapalı (`workers_dev = false`). Panel gelince açılacak ve şifreyle korunacak.

## Gizli bilgiler (kesin)
- Token ve app secret **asla** repoya, sohbete ya da ekran görüntüsüne girmez.
- Yerelde token: masaüstündeki `ig-token.txt` (bu klasörün dışında). Yayında: Cloudflare secret `IG_TOKEN`.
- Token 60 günde biter. Worker yenilenmiş token'ı KV'de (`token`, `token_tarih`) tutar; KV'de yoksa secret `IG_TOKEN` kullanılır.
  Elle yeni token alınırsa secret'ı güncelle **ve** KV'deki `token` anahtarını sil, yoksa eski KV token'ı kullanılmaya devam eder.
- Her push öncesi tarama: `git grep --cached` ile token/secret kalıntısı ara.
- `PRIVACY.md` söz veriyor: yalnız cevaplanmış yorum numaraları saklanır, 30 günde silinir. Kod buna uymalı.

## Fazlar
| # | Faz | Durum |
|---|---|---|
| 0 | Hazırlık (Facebook, Meta geliştirici, klasör, GitHub) | ✅ |
| 1 | Meta uygulaması + token, `/me` testi | ✅ 22 Ekim |
| 2 | Elle DM: yorumu oku, private reply at | ✅ 22 Ekim, takip etmeyen yabancıya DM gitti |
| 3 | Worker + cron: yorumları dakikada bir okuyor | ✅ 22 Ekim |
| 4 | Kelime → otomatik DM, KV ile tekrar yok | ✅ 22 Ekim, ilk otomatik DM'ler gitti |
| 5 | Takip şartı, video bazında (aşağıdaki not) | Panelle birlikte |
| 6 | Token'ın kendini yenilemesi (60 gün) | ✅ 22 Ekim yüklendi. Gece cron'u (03:00 UTC) 7 günden eski token'ı yeniler, KV'ye yazar. İlk başarılı yenileme logda doğrulanmalı |
| 7 | Gerçek videoda kullanım (altın kelimeler Eren'de) | |
| 8 | **Panel:** kampanyaları ve DM geçmişini tarayıcıdan yönetmek | Sırada, planlanacak |

### Faz 5 notu: takip şartı (Eren, 22 Ekim 2026)
Panelde her videonun kendi ayarı olacak: **"Herkese DM"** ya da **"Sadece takipçilere DM"**.
"Sadece takipçiler" seçili videoda kelimeyi yazan kişi takip ediyorsa link gider, etmiyorsa gitmez (ya da "takip et" hatırlatması).
- Teknik engel: Instagram takip bilgisini (`is_user_follow_business`) yorum anında vermiyor; kişi önce DM'de bir butona basmalı
  ya da mesaj yazmalı. Buton tıklaması mesaj webhook'uyla geliyor; webhook'suz (polling) yolla nasıl okunacağı araştırılacak
  (ör. konuşmaları `/me/conversations` ile okumak). Planlarken önce bunu küçük bir elle testle doğrula.

Her "çalıştı" anı bir commit. Kodu Claude yazar, Eren inceler; git komutlarını Eren yazar.
