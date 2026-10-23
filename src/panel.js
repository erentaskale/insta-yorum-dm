// Panel: tarayıcıdan gelen istekleri karşılar. Önce giriş, sonra panel ve API'si.
//
//   GET  /               giriş yoksa giriş sayfası, varsa panel (src/tarayici/panel.html)
//   GET  /panel.js       panelin tarayıcı kodu (src/tarayici/panel.js)
//   GET  /api/durum      videolar, kampanyalar, DM sayıları, token durumu
//   POST /api/kampanya   bir videonun ayarını kaydeder (KV: kampanyalar)
//
// Gizli bilgiler (Cloudflare secret, `npm run sifre` yükler):
//   PANEL_KULLANICI   kullanıcı adı
//   PANEL_SIFRE_HASH  şifrenin PBKDF2 özeti: "pbkdf2$<tur>$<tuz>$<özet>" (şifrenin kendisi hiçbir yerde yok)
//   OTURUM_ANAHTARI   giriş çerezini imzalayan rastgele anahtar

const OTURUM_SURESI_SN = 7 * 24 * 60 * 60;
const CEREZ = "__Host-oturum"; // __Host-: yalnız HTTPS, yalnız bu adres

import PANEL_HTML from "./tarayici/panel.html";
import PANEL_JS from "./tarayici/panel.js";
import {
  VIDEO_SAYISI, TOKEN_OMRU_MS, DAKIKADA_DM,
  tokenAl, kampanyalariOku, kayitOku, muslukOku, instagramdanAl,
} from "./instagram.js";

// Instagram'ın mesaj ve kelime sınırlarına uygun, panelde de aynı sınırlar var.
const EN_UZUN_KELIME = 50;
const EN_UZUN_MESAJ = 1000;

// Tahmin saldırısına karşı: aynı IP'den dakikada en fazla 5 giriş denemesi (wrangler.toml'da GIRIS_SINIRI).
// Sayaç KV'de değil: KV'nin günlük 1.000 yazma hakkı DM kayıtlarıyla ortak, saldırgan onu tüketemesin.

export async function panel(istek, env) {
  const adres = new URL(istek.url);
  const yol = adres.pathname;

  if (yol === "/giris" && istek.method === "POST") return girisYap(istek, env);
  if (yol === "/cikis" && istek.method === "POST") return cikisYap();

  const oturum = await oturumVarMi(istek, env);
  if (yol === "/" && istek.method === "GET") {
    return oturum ? sayfa(PANEL_HTML) : sayfa(girisSayfasi());
  }

  // Buradan sonrası yalnız giriş yapmış olana.
  if (!oturum) return json({ hata: "Giriş gerekli." }, 401);

  if (yol === "/panel.js" && istek.method === "GET") {
    return new Response(PANEL_JS, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", ...guvenlikBasliklari() },
    });
  }
  if (yol === "/api/durum" && istek.method === "GET") return durum(env);
  if (yol === "/api/kampanya" && istek.method === "POST") {
    // Başka bir siteden bize istek attırılmasın (CSRF): istek bu adresin kendi sayfasından gelmeli.
    if (istek.headers.get("Origin") !== adres.origin) return json({ hata: "İzin yok." }, 403);
    return kampanyaKaydet(istek, env);
  }
  return new Response("Bulunamadı", { status: 404, headers: guvenlikBasliklari() });
}

// --- API ---

async function durum(env) {
  const kampanyalar = await kampanyalariOku(env);

  // Videolar ve token sağlığı tek istekte: Instagram cevap veriyorsa token çalışıyor demektir.
  let videolar = [];
  let instagramHatasi = null;
  try {
    const alanlar = "id,caption,thumbnail_url,media_url,timestamp,permalink";
    const veri = await instagramdanAl(
      await tokenAl(env),
      `/me/media?fields=${encodeURIComponent(alanlar)}&limit=${VIDEO_SAYISI}`
    );
    videolar = (veri.data ?? []).map((v) => ({
      id: v.id,
      kapak: v.thumbnail_url ?? v.media_url ?? null,
      aciklama: (v.caption ?? "").slice(0, 200),
      tarih: v.timestamp,
      link: v.permalink,
    }));
  } catch (hata) {
    console.log(`Panel: ${hata.message}`);
    instagramHatasi = hata.message;
  }

  // DM sayısı = son 30 günde bu videodan DM alan kişi sayısı; yalnız aktif videolar için.
  const sayilar = {};
  const aktifler = Object.keys(kampanyalar).filter((id) => kampanyalar[id].aktif);
  await Promise.all(
    aktifler.map(async (id) => {
      sayilar[id] = kayitOku(await env.KAYIT.get(`dm:${id}`)).kisiler.length;
    })
  );

  // Musluk: aktif videolarda DM bekleyenler (pasif videonun sırası bekler, sayılmaz) ve bugün giden DM.
  const musluk = muslukOku(await env.KAYIT.get("musluk"));
  const sirada = {};
  for (const s of musluk.kuyruk) if (kampanyalar[s.v]?.aktif) sirada[s.v] = (sirada[s.v] ?? 0) + 1;
  const bugun = musluk.gun === new Date().toISOString().slice(0, 10) ? musluk.bugun : 0;

  // token_tarih yoksa token hiç yenilenmemiş; ne zaman alındığını bilmiyoruz.
  const tokenTarih = Number((await env.KAYIT.get("token_tarih")) ?? 0);
  const kalanGun = tokenTarih ? Math.floor((tokenTarih + TOKEN_OMRU_MS - Date.now()) / 86400000) : null;

  return json({
    videolar,
    kampanyalar,
    sayilar,
    musluk: { sirada, bugun, dakikadaDm: DAKIKADA_DM },
    token: { kalanGun, hata: instagramHatasi },
  });
}

async function kampanyaKaydet(istek, env) {
  const veri = await istek.json().catch(() => null);
  const video = String(veri?.video ?? "");
  const aktif = veri?.aktif === true;
  const kelime = String(veri?.kelime ?? "").trim();
  const mesaj = String(veri?.mesaj ?? "").trim();

  if (!/^\d{1,30}$/.test(video)) return json({ hata: "Video numarası geçersiz." }, 400);
  if (kelime.length > EN_UZUN_KELIME) return json({ hata: `Kelime en fazla ${EN_UZUN_KELIME} karakter olabilir.` }, 400);
  if (mesaj.length > EN_UZUN_MESAJ) return json({ hata: `Mesaj en fazla ${EN_UZUN_MESAJ} karakter olabilir.` }, 400);
  if (aktif && (!kelime || !mesaj)) return json({ hata: "Aktif video için kelime ve mesaj gerekli." }, 400);

  const kampanyalar = await kampanyalariOku(env);
  if (!aktif && !kelime && !mesaj) delete kampanyalar[video]; // Boş ve pasif: kaydı tutmaya gerek yok.
  else kampanyalar[video] = { aktif, kelime, mesaj };
  await env.KAYIT.put("kampanyalar", JSON.stringify(kampanyalar));

  console.log(`Panel: kampanya kaydedildi | video ${video} | ${aktif ? "aktif" : "pasif"}`);
  return json({ kampanya: kampanyalar[video] ?? null });
}

async function girisYap(istek, env) {
  const ip = istek.headers.get("CF-Connecting-IP") ?? "bilinmiyor";
  const { success } = await env.GIRIS_SINIRI.limit({ key: ip });
  if (!success) {
    return sayfa(girisSayfasi("Çok fazla deneme. Bir dakika sonra tekrar dene."), 429);
  }

  const form = await istek.formData();
  const kullanici = String(form.get("kullanici") ?? "");
  const sifre = String(form.get("sifre") ?? "");

  // Kullanıcı adı yanlış olsa da şifre özetini hesapla: cevap süresi ipucu vermesin.
  const sifreDogru = await sifreDogruMu(sifre, env.PANEL_SIFRE_HASH);
  const kullaniciDogru = await esitMi(kullanici, env.PANEL_KULLANICI ?? "");

  if (!sifreDogru || !kullaniciDogru) {
    console.log("Panel: yanlış giriş denemesi");
    return sayfa(girisSayfasi("Kullanıcı adı ya da şifre yanlış."), 401);
  }

  const bitis = Math.floor(Date.now() / 1000) + OTURUM_SURESI_SN;
  const deger = `${bitis}.${await imzala(String(bitis), env.OTURUM_ANAHTARI)}`;
  return yonlendir("/", `${CEREZ}=${deger}; Path=/; Max-Age=${OTURUM_SURESI_SN}; HttpOnly; Secure; SameSite=Strict`);
}

function cikisYap() {
  return yonlendir("/", `${CEREZ}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

// Çerez bizim imzamızı taşıyor mu ve süresi geçmedi mi?
export async function oturumVarMi(istek, env) {
  const cerezler = istek.headers.get("Cookie") ?? "";
  const deger = cerezler.split(/;\s*/).find((c) => c.startsWith(`${CEREZ}=`))?.slice(CEREZ.length + 1);
  if (!deger || !env.OTURUM_ANAHTARI) return false;

  const [bitis, imza] = deger.split(".");
  if (!bitis || !imza || Number(bitis) < Date.now() / 1000) return false;
  return esitMi(imza, await imzala(bitis, env.OTURUM_ANAHTARI));
}

// --- Şifre ve imza ---

async function sifreDogruMu(sifre, kayitli) {
  const [tur, sayi, tuz, ozet] = (kayitli ?? "").split("$");
  // Secret yoksa ya da bozuksa kimse giremez.
  if (tur !== "pbkdf2" || !sayi || !tuz || !ozet) return false;
  return esitMi(await pbkdf2(sifre, tuz, Number(sayi)), ozet);
}

// scripts/sifre.mjs ile aynı hesap: PBKDF2-SHA256, 32 bayt, base64.
async function pbkdf2(sifre, tuzBase64, tur) {
  const anahtar = await crypto.subtle.importKey("raw", new TextEncoder().encode(sifre), "PBKDF2", false, ["deriveBits"]);
  const bitler = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64Coz(tuzBase64), iterations: tur },
    anahtar,
    256
  );
  return base64(bitler);
}

async function imzala(metin, anahtarMetni) {
  const anahtar = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(anahtarMetni ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64(await crypto.subtle.sign("HMAC", anahtar, new TextEncoder().encode(metin)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Sabit sürede karşılaştırma: kaçıncı harfte yanlış olduğu cevap süresinden anlaşılmasın.
// Önce ikisinin de özetini alıyoruz ki uzunluk farkı da sızmasın.
async function esitMi(a, b) {
  const ozet = async (s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [x, y] = await Promise.all([ozet(a), ozet(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function base64(tampon) {
  return btoa(String.fromCharCode(...new Uint8Array(tampon)));
}

function base64Coz(metin) {
  return Uint8Array.from(atob(metin), (c) => c.charCodeAt(0));
}

// --- Cevaplar ---

function guvenlikBasliklari() {
  return {
    // Kod yalnız kendi adresimizden, resim yalnız Instagram'ın sunucularından; başka sitede çerçeve içinde açılamaz.
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'self'",
      "connect-src 'self'",
      "img-src https://*.fbcdn.net https://*.cdninstagram.com",
      "style-src 'unsafe-inline'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-store",
  };
}

function sayfa(html, durum = 200) {
  return new Response(html, {
    status: durum,
    headers: { "Content-Type": "text/html; charset=utf-8", ...guvenlikBasliklari() },
  });
}

function json(veri, durum = 200) {
  return new Response(JSON.stringify(veri), {
    status: durum,
    headers: { "Content-Type": "application/json; charset=utf-8", ...guvenlikBasliklari() },
  });
}

function yonlendir(yer, cerez) {
  return new Response(null, { status: 303, headers: { Location: yer, "Set-Cookie": cerez, ...guvenlikBasliklari() } });
}

// --- Giriş sayfası (şimdilik gri; tasarım en son) ---

function kabuk(govde) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DM Paneli</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f4f2; color: #222; margin: 0; }
  main { max-width: 360px; margin: 15vh auto; padding: 0 16px; }
  form { display: flex; flex-direction: column; gap: 10px; }
  input, button { font: inherit; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; }
  button { background: #222; color: #fff; border: 0; cursor: pointer; }
  .hata { color: #a32d2d; margin: 0; }
</style>
</head>
<body><main>${govde}</main></body>
</html>`;
}

function girisSayfasi(hata = "") {
  return kabuk(`
<h1>DM Paneli</h1>
<form method="post" action="/giris">
  <input name="kullanici" placeholder="Kullanıcı adı" autocomplete="username" required>
  <input name="sifre" type="password" placeholder="Şifre" autocomplete="current-password" required>
  ${hata ? `<p class="hata">${hata}</p>` : ""}
  <button>Giriş yap</button>
</form>`);
}
