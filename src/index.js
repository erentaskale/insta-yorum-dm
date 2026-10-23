// insta-yorum-dm: dakikada bir aktif videoların yorumlarını okur,
// kampanyanın kelimesini yazan kişiye video başına bir kez DM atar.
//
// Kampanyalar KV'de, "kampanyalar" anahtarında durur (panel yazar, cron okur):
//   { "<video numarası>": { aktif: true, kelime: "skill", mesaj: "Selam! İşte link: ..." } }

const API = "https://graph.instagram.com";

// Kendi yorumlarımıza DM atmayalım.
const HESAP = "yager.dev";

// Tek istekte son kaç video çekilecek ve video başına kaç yorum okunacak.
// Instagram çoklu video isteğini (?ids=) kaldırdı; aktif videoyu bu pencerenin içinde ararız.
const VIDEO_SAYISI = 25;
const YORUM_SAYISI = 50;

// Meta kuralı: yoruma en fazla 7 gün içinde cevap verilebilir.
const CEVAP_SURESI_MS = 7 * 24 * 60 * 60 * 1000;

// Kayıt defterindeki yorum ve kişi numaraları 30 gün sonra silinir (PRIVACY.md'deki söz).
const KAYIT_SURESI_SN = 30 * 24 * 60 * 60;

// Instagram bazen kalıcı hatayı da 500 olarak döndürüyor; sonsuza dek denemeyelim.
const EN_FAZLA_DENEME = 3;

// Token 60 günde biter; 7 günden eskiyse gece yenilenir.
const YENILEME_ARALIGI_MS = 7 * 24 * 60 * 60 * 1000;
const GECE_CRON = "0 3 * * *";

export default {
  // Cloudflare bu fonksiyonu wrangler.toml'daki cron'lara göre çağırır.
  async scheduled(event, env, ctx) {
    if (event.cron === GECE_CRON) return tokenYenile(env);
    return yorumlaraBak(env);
  },
};

// Kullanılacak token: KV'deki yenilenmiş olan, yoksa ilk yüklenen secret.
async function tokenAl(env) {
  return (await env.KAYIT.get("token")) ?? env.IG_TOKEN;
}

async function tokenYenile(env) {
  const tarih = Number((await env.KAYIT.get("token_tarih")) ?? 0);
  if (Date.now() - tarih < YENILEME_ARALIGI_MS) {
    console.log("Token yenileme: daha 7 gün olmadı, gerek yok.");
    return;
  }

  const eski = await tokenAl(env);
  const adres = `${API}/refresh_access_token?grant_type=ig_refresh_token`;
  const cevap = await fetch(adres, { headers: { Authorization: `Bearer ${eski}` } });
  const veri = await cevap.json().catch(() => ({}));

  if (!cevap.ok || !veri.access_token) {
    // İlk 24 saatte Instagram yenilemeye izin vermez; yarın gece tekrar denenir.
    console.log(`Token yenilenemedi (${cevap.status}): ${JSON.stringify(veri.error ?? veri)}`);
    return;
  }

  await env.KAYIT.put("token", veri.access_token);
  await env.KAYIT.put("token_tarih", String(Date.now()));
  const gun = Math.round((veri.expires_in ?? 0) / 86400);
  console.log(`Token yenilendi, ${gun} gün geçerli.`);
}

// Panelin kaydettiği kampanyalar; yalnız aktif olanlar.
async function aktifKampanyalar(env) {
  const hepsi = JSON.parse((await env.KAYIT.get("kampanyalar")) ?? "{}");
  return Object.fromEntries(Object.entries(hepsi).filter(([, k]) => k.aktif));
}

async function yorumlaraBak(env) {
  const kampanyalar = await aktifKampanyalar(env);
  if (Object.keys(kampanyalar).length === 0) {
    // Instagram'a hiç sormayalım; saatlik istek hakkı boşa gitmesin.
    console.log("Aktif kampanya yok, kontrol atlandı.");
    return;
  }

  const token = await tokenAl(env);
  const videolar = await sonVideolar(token);
  let gonderilen = 0;

  const bulunanlar = new Set(videolar.map((v) => v.id));
  for (const id of Object.keys(kampanyalar)) {
    if (!bulunanlar.has(id)) console.log(`Uyarı: aktif video ${id} son ${VIDEO_SAYISI} videoda yok, izlenemiyor.`);
  }

  for (const video of videolar) {
    const kampanya = kampanyalar[video.id];
    if (!kampanya) continue; // Bu videoda aktif otomasyon yok.

    const adaylar = (video.comments?.data ?? []).filter((y) => dmGerekirMi(y, kampanya));
    if (adaylar.length === 0) continue;

    // Bu videonun kaydı: işi biten yorumlar, DM alan kişiler
    // ve geçici hata alanların deneme sayısı.
    const anahtar = `dm:${video.id}`;
    const kayit = kayitOku(await env.KAYIT.get(anahtar));
    const bitenler = new Set(kayit.bitti);
    const kisiler = new Set(kayit.kisiler);
    let degisti = false;

    for (const yorum of adaylar) {
      if (bitenler.has(yorum.id)) continue;
      // Aynı kişi kelimeyi kaç kez yazarsa yazsın bu videodan tek DM alır.
      const kisi = yorum.from?.id;
      if (kisi && kisiler.has(kisi)) continue;

      const sonuc = await dmAt(token, yorum.id, kampanya.mesaj);
      degisti = true;
      if (sonuc.ok) {
        console.log(`DM gitti | video ${video.id} | yorum ${yorum.id}`);
        gonderilen++;
        if (kisi) kisiler.add(kisi);
      } else {
        const deneme = (kayit.deneme[yorum.id] ?? 0) + 1;
        console.log(`DM gitmedi (${deneme}. deneme) | yorum ${yorum.id} | ${sonuc.hata}`);
        // Geçici hatada sonraki dakika tekrar dene, ama en fazla EN_FAZLA_DENEME kez.
        if (!sonuc.kalici && deneme < EN_FAZLA_DENEME) {
          kayit.deneme[yorum.id] = deneme;
          continue;
        }
      }
      // Başarılı, kalıcı hata ya da deneme hakkı bitti: bu yorumu bir daha deneme.
      bitenler.add(yorum.id);
      delete kayit.deneme[yorum.id];
    }

    if (degisti) {
      const yeni = { bitti: [...bitenler], kisiler: [...kisiler], deneme: kayit.deneme };
      await env.KAYIT.put(anahtar, JSON.stringify(yeni), { expirationTtl: KAYIT_SURESI_SN });
    }
  }
  console.log(`Kontrol bitti: ${videolar.length} video, ${gonderilen} DM.`);
}

// Kayıt defterindeki değeri okur. Eski sürümlerin kayıtlarını da anlar
// (ilki düz liste yazıyordu, ikincisinde kisiler yoktu).
function kayitOku(metin) {
  const veri = JSON.parse(metin ?? "null");
  if (Array.isArray(veri)) return { bitti: veri, kisiler: [], deneme: {} };
  return { bitti: veri?.bitti ?? [], kisiler: veri?.kisiler ?? [], deneme: veri?.deneme ?? {} };
}

// Yorum bu kampanyanın kelimesini içeriyor mu, kendi yorumumuz değil mi, 7 gün geçmedi mi?
function dmGerekirMi(yorum, kampanya) {
  if (yorum.username === HESAP) return false;
  if (Date.now() - new Date(yorum.timestamp).getTime() > CEVAP_SURESI_MS) return false;
  return sadelestir(yorum.text).includes(sadelestir(kampanya.kelime));
}

// "SKİLL", "Skıll", "skill" hepsi aynı sayılsın diye: küçük harf, ı→i, İ'nin noktasını at.
function sadelestir(yazi) {
  return (yazi ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/̇/g, "")
    .replace(/ı/g, "i");
}

// Tek istekte son videoları yorumlarıyla birlikte ister (saatte 200 istek sınırı için).
async function sonVideolar(token) {
  const alanlar = `id,comments.limit(${YORUM_SAYISI}){id,text,timestamp,username,from}`;
  const adres = `${API}/me/media?fields=${encodeURIComponent(alanlar)}&limit=${VIDEO_SAYISI}`;

  const cevap = await fetch(adres, { headers: { Authorization: `Bearer ${token}` } });
  const veri = await cevap.json();

  if (!cevap.ok) {
    throw new Error(`Instagram hata verdi (${cevap.status}): ${JSON.stringify(veri.error ?? veri)}`);
  }
  return veri.data ?? [];
}

// Yoruma özel cevap (private reply): mesaj yorum yapanın DM kutusuna düşer.
async function dmAt(token, yorumId, mesaj) {
  const cevap = await fetch(`${API}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { comment_id: yorumId }, message: { text: mesaj } }),
  });
  if (cevap.ok) return { ok: true };

  const veri = await cevap.json().catch(() => ({}));
  // 429 (çok istek) ve 5xx (Instagram tarafı) geçicidir; diğer 4xx'ler kalıcı sayılır.
  const kalici = cevap.status >= 400 && cevap.status < 500 && cevap.status !== 429;
  return { ok: false, kalici, hata: `${cevap.status} ${JSON.stringify(veri.error ?? veri)}` };
}
