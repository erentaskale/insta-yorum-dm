// insta-yorum-dm: dakikada bir aktif videoların yorumlarını okur,
// kampanyanın kelimesini yazan kişiye video başına bir kez DM atar.
//
// Kampanyalar KV'de, "kampanyalar" anahtarında durur (panel yazar, cron okur):
//   { "<video numarası>": { aktif: true, kelime: "skill", mesaj: "Selam! İşte link: ..." } }

import { panel } from "./panel.js";
import {
  API, VIDEO_SAYISI, DAKIKADA_DM, GUNLUK_TAVAN,
  tokenAl, kampanyalariOku, kayitOku, muslukOku, instagramdanAl,
} from "./instagram.js";

// Kendi yorumlarımıza DM atmayalım.
const HESAP = "yager.dev";

// Video başına kaç yorum okunacak.
const YORUM_SAYISI = 50;

// Meta kuralı: yoruma en fazla 7 gün içinde cevap verilebilir.
const CEVAP_SURESI_MS = 7 * 24 * 60 * 60 * 1000;

// Kayıt defterindeki yorum ve kişi numaraları 30 gün sonra silinir (PRIVACY.md'deki söz).
const KAYIT_SURESI_SN = 30 * 24 * 60 * 60;

// Instagram bazen kalıcı hatayı da 500 olarak döndürüyor; sonsuza dek denemeyelim.
const EN_FAZLA_DENEME = 3;

// Meta'nın "çok fazla istek" hata kodları (uygulama, kullanıcı, sayfa ve API limitleri).
const LIMIT_KODLARI = [4, 17, 32, 613];

// Token 60 günde biter; 7 günden eskiyse gece yenilenir.
const YENILEME_ARALIGI_MS = 7 * 24 * 60 * 60 * 1000;
const GECE_CRON = "0 3 * * *";

export default {
  // Tarayıcıdan gelen istekler: panel (src/panel.js).
  fetch: panel,

  // Cloudflare bu fonksiyonu wrangler.toml'daki cron'lara göre çağırır.
  async scheduled(event, env, ctx) {
    if (event.cron === GECE_CRON) return tokenYenile(env);
    return yorumlaraBak(env);
  },
};

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
  const hepsi = await kampanyalariOku(env);
  return Object.fromEntries(Object.entries(hepsi).filter(([, k]) => k.aktif));
}

// Her dakika iki iş: (1) kelimeyi yazanları kuyruğa ekle, (2) musluk: kuyruğun başından
// en fazla DAKIKADA_DM kişiye DM at. Kuyruk KV'de (`musluk`) durur; kişi son 50 yorumun
// dışına düşse bile unutulmaz. İlk yazan ilk alır (FIFO), kimse atlanmaz, sistem yalnız yavaşlar.
async function yorumlaraBak(env) {
  const kampanyalar = await aktifKampanyalar(env);
  if (Object.keys(kampanyalar).length === 0) {
    // Instagram'a hiç sormayalım; saatlik istek hakkı boşa gitmesin.
    // Pasif videoların kuyruktaki kişileri bekler; video tekrar aktif olunca devam edilir.
    console.log("Aktif kampanya yok, kontrol atlandı.");
    return;
  }

  const token = await tokenAl(env);
  const videolar = await sonVideolar(token);

  const bulunanlar = new Set(videolar.map((v) => v.id));
  for (const id of Object.keys(kampanyalar)) {
    if (!bulunanlar.has(id)) console.log(`Uyarı: aktif video ${id} son ${VIDEO_SAYISI} videoda yok, izlenemiyor.`);
  }

  const musluk = muslukOku(await env.KAYIT.get("musluk"));
  const bugun = new Date().toISOString().slice(0, 10); // UTC günü
  if (musluk.gun !== bugun) Object.assign(musluk, { gun: bugun, bugun: 0 });
  let muslukDegisti = false;

  // Video kayıtları (dm:<id>) bu çalışmada bir kez okunur, değişenler sonda yazılır.
  const kayitlar = {};
  const kayitAl = async (id) => (kayitlar[id] ??= { ...kayitOku(await env.KAYIT.get(`dm:${id}`)), degisti: false });

  // --- 1. Kelimeyi yazanları kuyruğa ekle ---
  const siradakiYorumlar = new Set(musluk.kuyruk.map((s) => s.y));
  const siradakiKisiler = new Set(musluk.kuyruk.filter((s) => s.k).map((s) => `${s.v}:${s.k}`));
  for (const video of videolar) {
    const kampanya = kampanyalar[video.id];
    if (!kampanya) continue; // Bu videoda aktif otomasyon yok.

    const adaylar = (video.comments?.data ?? []).filter((y) => dmGerekirMi(y, kampanya));
    if (adaylar.length === 0) continue;

    const kayit = await kayitAl(video.id);
    for (const yorum of adaylar) {
      if (kayit.bitti.includes(yorum.id) || siradakiYorumlar.has(yorum.id)) continue;
      // Aynı kişi kelimeyi kaç kez yazarsa yazsın bu videodan tek DM alır: DM aldıysa ya da zaten sıradaysa geç.
      const kisi = yorum.from?.id ?? null;
      if (kisi && (kayit.kisiler.includes(kisi) || siradakiKisiler.has(`${video.id}:${kisi}`))) continue;

      musluk.kuyruk.push({ v: video.id, y: yorum.id, k: kisi, t: yorum.timestamp });
      siradakiYorumlar.add(yorum.id);
      if (kisi) siradakiKisiler.add(`${video.id}:${kisi}`);
      muslukDegisti = true;
    }
  }

  // İlk yazan önde; 7 günü geçen yoruma Meta cevap izni vermez, kuyruktan düşer.
  musluk.kuyruk.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const once = musluk.kuyruk.length;
  musluk.kuyruk = musluk.kuyruk.filter((s) => Date.now() - Date.parse(s.t) <= CEVAP_SURESI_MS);
  if (musluk.kuyruk.length !== once) {
    console.log(`Kuyruk: ${once - musluk.kuyruk.length} kişi 7 günü geçtiği için düştü.`);
    muslukDegisti = true;
  }

  // --- 2. Musluk: sıranın başından dakikada en fazla DAKIKADA_DM kişi ---
  let hak = Math.min(DAKIKADA_DM, GUNLUK_TAVAN - musluk.bugun);
  if (hak <= 0 && musluk.kuyruk.length > 0) console.log(`Günlük tavan (${GUNLUK_TAVAN} DM) doldu, kuyruk yarın devam eder.`);
  let limitCarpti = false;
  let gonderilen = 0;
  const kalanlar = [];

  for (const sira of musluk.kuyruk) {
    const kampanya = kampanyalar[sira.v];
    // Pasif videonun sırası bekler, hak yemez. Limit çarptıysa bu dakika kimseye denenmez.
    if (!kampanya || limitCarpti || hak <= 0) {
      kalanlar.push(sira);
      continue;
    }

    hak--;
    muslukDegisti = true;
    const kayit = await kayitAl(sira.v);
    const sonuc = await dmAt(token, sira.y, kampanya.mesaj);

    if (sonuc.limit) {
      // Meta "yavaşla" dedi: deneme hakkı yemez, kişi sıradaki yerini korur, sonraki dakika devam.
      console.log(`Meta limiti: bu dakika durduruldu, kuyruk sonraki dakika devam eder | ${sonuc.hata}`);
      limitCarpti = true;
      kalanlar.push(sira);
      continue;
    }

    kayit.degisti = true;
    if (sonuc.ok) {
      console.log(`DM gitti | video ${sira.v} | yorum ${sira.y}`);
      gonderilen++;
      musluk.bugun++;
      if (sira.k) kayit.kisiler.push(sira.k);
    } else {
      const deneme = (kayit.deneme[sira.y] ?? 0) + 1;
      console.log(`DM gitmedi (${deneme}. deneme) | yorum ${sira.y} | ${sonuc.hata}`);
      // Geçici hatada sonraki dakika tekrar dene, ama en fazla EN_FAZLA_DENEME kez.
      if (!sonuc.kalici && deneme < EN_FAZLA_DENEME) {
        kayit.deneme[sira.y] = deneme;
        kalanlar.push(sira);
        continue;
      }
    }
    // Başarılı, kalıcı hata ya da deneme hakkı bitti: bu yorumu bir daha deneme.
    kayit.bitti.push(sira.y);
    delete kayit.deneme[sira.y];
  }
  musluk.kuyruk = kalanlar;

  // --- 3. Değişenleri yaz (KV'nin günde 1.000 yazma hakkı var; değişmeyen yazılmaz) ---
  for (const [id, kayit] of Object.entries(kayitlar)) {
    if (!kayit.degisti) continue;
    const yeni = { bitti: kayit.bitti, kisiler: kayit.kisiler, deneme: kayit.deneme };
    await env.KAYIT.put(`dm:${id}`, JSON.stringify(yeni), { expirationTtl: KAYIT_SURESI_SN });
  }
  if (muslukDegisti) await env.KAYIT.put("musluk", JSON.stringify(musluk));

  console.log(`Kontrol bitti: ${videolar.length} video, ${gonderilen} DM, kuyrukta ${musluk.kuyruk.length} kişi.`);
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
  const veri = await instagramdanAl(token, `/me/media?fields=${encodeURIComponent(alanlar)}&limit=${VIDEO_SAYISI}`);
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
  // Meta limit hatasını bazen 429, bazen 400 + hata kodu ile döndürür; ikisi de "yavaşla" demek.
  const limit = cevap.status === 429 || LIMIT_KODLARI.includes(veri.error?.code);
  // 5xx (Instagram tarafı) geçicidir; limit dışındaki 4xx'ler kalıcı sayılır.
  const kalici = !limit && cevap.status >= 400 && cevap.status < 500;
  return { ok: false, limit, kalici, hata: `${cevap.status} ${JSON.stringify(veri.error ?? veri)}` };
}
