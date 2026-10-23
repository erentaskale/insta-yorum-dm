# insta-yorum-dm

`@yager.dev` reels'lerine anahtar kelime yazan kişiye otomatik DM gönderen kendi sistemimiz.
Ücretsiz, marka yazısı yok. Hazır araçların (LinkDM vb.) yerine geçer; portföy projesi.

Bu dosya projenin ortak hafızası: bu klasörde açılan her oturum önce bunu okur. Karar ya da durum değişince burası güncellenir.
**Panel işine başlıyorsan önce `PANEL-DEVIR.md`'yi oku.**

## Nasıl çalışır
- Cloudflare Worker (`src/index.js`) cron ile **her dakika** çalışır. Aynı Worker paneli de sunar (`src/panel.js`,
  tarayıcı dosyaları `src/tarayici/`, ortak Instagram/KV yardımcıları `src/instagram.js`).
- Panel: https://insta-yorum-dm.suppoldum.workers.dev — solda son 25 video, sağda seçili videonun ayarı
  (aktif, altın kelime, mesaj). Üstte son 30 günün DM sayısı, aktif video sayısı, token durumu.
  Panel açılışı Instagram'a 1 istek atar (saatlik ~200 hakkından).
- Kampanyalar KV'de, `kampanyalar` anahtarında: `{ "<video id>": { aktif, kelime, mesaj } }`. Panel yazar, cron okur.
  Aktif kampanya yoksa Instagram'a hiç istek atılmaz.
- Tek istekte son 25 videoyu, her birinin son 50 yorumuyla alır (`?ids=` ile seçili video isteği v26'da kaldırıldı).
  Aktif video bu 25'in dışındaysa izlenmez, logda uyarı çıkar.
- Aktif videoda kelime eşleşirse yorum yapan **kuyruğa** girer (KV: `musluk`), DM'i musluk atar:
  - **FIFO:** ilk yazan ilk alır. Kuyruk KV'de olduğu için son 50 yorumun dışına düşen kişi unutulmaz.
  - **Rate limiting:** dakikada en fazla 2 DM, günde en fazla 1.000 (UTC günü). 300 kişi → son kişi ~150 dk.
    Neden 2: saatte 60 okuma + 120 DM = 180, Meta'nın ~200 sınırının altında (3 olsa 240 ederdi).
  - Meta limit hatası (429 ya da kod 4/17/32/613) deneme hakkı yemez: o dakika durur, sonraki dakika devam.
  - Pasif videonun sırası bekler (gönderilmez, silinmez); 7 günü geçen yorum kuyruktan düşer.
  - KV'ye yalnız değişen yazılır; boş dakikada yazma yok.
- KV (`KAYIT`): video başına DM atılan yorum numaraları ve DM alan kişilerin numaraları (`from.id`).
  Aynı kişi kelimeyi kaç kez yazarsa yazsın o videodan tek DM alır; farklı videodan ayrıca alabilir. 30 günde silinir.
- Geçici hatada (429/5xx) en fazla 3 deneme; Instagram kalıcı hatayı da 500 döndürebiliyor.
- **Bilinen sınır:** video başına dakikada son 50 yorum okunuyor. Dakikada 50'den fazla yorum alan videoda
  aradaki yorumlar hiç görülmeyebilir (sayfalama yok; her sayfa saatlik istek hakkından yer).

## Komutlar (proje klasöründe, PowerShell)
- Yeni video/kelime: panelden (panel gelene kadar: JSON'u bir dosyaya yaz,
  `npx wrangler kv key put kampanyalar --path <dosya> --binding KAYIT --remote`)
- **Testler: `npm test`** (her deploy'dan önce). 47 test, ~3 sn. Worker yerel kopyada (Miniflare) çalışır;
  KV hafızada, Instagram sahte (`test/yardimci.js`), internet kilitli: canlıya ve gerçek Instagram'a hiçbir şey gitmez.
  Dosyalar: `test/musluk.test.js` (cron, kuyruk, hatalar), `test/guvenlik.test.js` (giriş, çerez, CSRF, XSS, başlıklar),
  `test/panel.test.js` (API, panel→cron uçtan uca, token yenileme). Test gizlileri `vitest.config.js`'de, sahte değerler.
- Canlı log: `npm run loglar`
- Panel kullanıcı adı/şifresi: `npm run sifre`
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
- **"API access blocked" (code 200):** 23 Ekim'de her istek bu hatayı aldı. Sebep yeni Facebook hesabının doğrulama
  istemesiydi; Eren Facebook'a girip e-posta + telefonu onaylayınca düzeldi. Bu hata görülürse önce Facebook hesabına bak.
- **Kelime eşleşmesi:** büyük/küçük harf, ı/i, İ farkı yok; kelimenin yorumda geçmesi yeter.
- **Takip şartı:** Eren için "blöf" yeterli; gerçek kontrol (Faz 5) isteğe bağlı.
- **Panel girişi (23 Ekim):** `workers.dev` adresi açık, `src/panel.js` korur. Kullanıcı adı + şifre; Cloudflare'de yalnız
  PBKDF2 özeti (`PANEL_SIFRE_HASH`), imzalı `__Host-` çerez (`OTURUM_ANAHTARI`, 7 gün). Giriş denemesi IP başına dakikada 5
  (`GIRIS_SINIRI`); sayaç KV'de değil, çünkü KV yazma hakkı DM kayıtlarıyla ortak. Secret yoksa kimse giremez.
  Şifre değiştirmek: `npm run sifre` (bütün oturumları da kapatır).

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
