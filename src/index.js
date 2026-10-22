// insta-yorum-dm: dakikada bir son videoların yorumlarını okur,
// ayarlar.js'deki kelimeyi yazan kişiye bir kez DM atar.

import { KAMPANYALAR, HESAP } from "./ayarlar.js";

const API = "https://graph.instagram.com";

// Son kaç videoya bakılacak ve video başına kaç yorum okunacak.
const VIDEO_SAYISI = 5;
const YORUM_SAYISI = 50;

// Meta kuralı: yoruma en fazla 7 gün içinde cevap verilebilir.
const CEVAP_SURESI_MS = 7 * 24 * 60 * 60 * 1000;

// Kayıt defterindeki numaralar 30 gün sonra silinir (PRIVACY.md'deki söz).
const KAYIT_SURESI_SN = 30 * 24 * 60 * 60;

// Instagram bazen kalıcı hatayı da 500 olarak döndürüyor; sonsuza dek denemeyelim.
const EN_FAZLA_DENEME = 3;

export default {
  // Cloudflare bu fonksiyonu wrangler.toml'daki cron'a göre her dakika çağırır.
  async scheduled(event, env, ctx) {
    const videolar = await sonVideolar(env.IG_TOKEN);
    let gonderilen = 0;

    for (const video of videolar) {
      const kampanya = KAMPANYALAR.find((k) => k.video === video.id);
      if (!kampanya) continue; // Bu videoda otomasyon yok.

      const adaylar = (video.comments?.data ?? []).filter((y) => dmGerekirMi(y, kampanya));
      if (adaylar.length === 0) continue;

      // Bu videonun kaydı: işi biten yorumlar + geçici hata alanların deneme sayısı.
      const anahtar = `dm:${video.id}`;
      const kayit = kayitOku(await env.KAYIT.get(anahtar));
      const bitenler = new Set(kayit.bitti);
      let degisti = false;

      for (const yorum of adaylar) {
        if (bitenler.has(yorum.id)) continue;

        const sonuc = await dmAt(env.IG_TOKEN, yorum.id, kampanya.mesaj);
        degisti = true;
        if (sonuc.ok) {
          console.log(`DM gitti | video ${video.id} | yorum ${yorum.id}`);
          gonderilen++;
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
        const yeni = { bitti: [...bitenler], deneme: kayit.deneme };
        await env.KAYIT.put(anahtar, JSON.stringify(yeni), { expirationTtl: KAYIT_SURESI_SN });
      }
    }
    console.log(`Kontrol bitti: ${videolar.length} video, ${gonderilen} DM.`);
  },
};

// Kayıt defterindeki değeri okur. İlk sürüm düz liste yazıyordu, onu da anlar.
function kayitOku(metin) {
  const veri = JSON.parse(metin ?? "null");
  if (Array.isArray(veri)) return { bitti: veri, deneme: {} };
  return { bitti: veri?.bitti ?? [], deneme: veri?.deneme ?? {} };
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
  const alanlar = `id,comments.limit(${YORUM_SAYISI}){id,text,timestamp,username}`;
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
