# insta-yorum-dm

`@yager.dev` reels'lerine anahtar kelime yazan kişiye otomatik DM gönderen kendi sistemimiz.
Ücretsiz, sınırsız, marka yazısı yok. Hazır araçların (LinkDM vb.) yerine geçecek; portföy projesi.

## Kararlar (21-22 Ekim 2026)
- **Webhook yok, polling var:** Meta belgesine göre `comments` webhook'u Advanced Access (App Review + Business Verification) istiyor.
  Bunun yerine sunucu dakikada bir son videoların yorumlarını kontrol eder (Standard Access yeter). DM en geç ~1 dk gecikir.
- **Araçlar:** JavaScript, Cloudflare Workers (Cron ile dakikalık çalışma) + KV (ayarlar, işlenmiş yorumlar). Maliyet 0.
- **Meta uygulaması:** `yager-dm`, kullanım alanı "Manage messaging & content on Instagram", işletme portföyü yok,
  `yager.dev` Instagram Tester. Yol: Instagram API with Instagram Login (`graph.instagram.com`).
- **Uygulama yayında (Published) olmalı:** Unpublished iken API yalnız rolü olanların yorumlarını döndürüyor
  (`comments_count` 14, liste boş geldi). Yayına almak için yalnız gizlilik linki istendi (`PRIVACY.md`), App Review gerekmedi.
- **Kurallar (Meta):** yorum başına 1 DM (private reply), yorumdan sonra en fazla 7 gün.
- **Takip şartı:** DM'de "Takip ettim" butonu → `is_user_follow_business` kontrolü. (Faz 5)

## Gizli bilgiler (kesin)
- Token ve app secret **asla** repoya, sohbete ya da ekran görüntüsüne girmez.
- Yerelde token: masaüstündeki `ig-token.txt` (bu klasörün dışında). Yayında: Cloudflare secret.
- Her push öncesi tarama: `git grep --cached` ile token/secret kalıntısı ara.

## Fazlar
| # | Faz | Durum |
|---|---|---|
| 0 | Hazırlık (Facebook + Meta geliştirici hesabı, klasör) | ✅ |
| 1 | Meta uygulaması + token, `/me` testi | ✅ (22 Ekim) |
| 2 | Elle DM: yorumu oku, private reply at | ✅ (22 Ekim) Takip etmeyen yabancıya DM gitti |
| 3 | Worker + Cron: yorumları dakikada bir oku, kaydet | |
| 4 | Kelime → DM (ayar listesi: video, kelime, link) | |
| 5 | Takip şartı (buton + kontrol) | |
| 6 | Sağlamlaştırma: aynı yoruma iki DM yok, 60 günlük token yenileme | |

`PRIVACY.md` söz veriyor: yalnız cevaplanmış yorum numaraları saklanır, 30 günde silinir (KV TTL). Kod buna uymalı.
| 7 | Yayın: gerçek videoda LinkDM'den geçiş | |

Her "çalıştı" anı bir commit. Kodu Claude yazar, Eren inceler; git komutlarını Eren yazar.
