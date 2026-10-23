// Testlerin ortak yardımcıları: sahte Instagram, cron'u çalıştırma, panele giriş.

import { env, createScheduledController, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi, beforeEach } from "vitest";
import worker from "../src/index.js";

export const ADRES = "https://panel.test";

// İnternet kilidi: her testten önce dışarıya bütün istekler kapalı. Test sahte Instagram kurmayı unutsa bile
// gerçek bir yere istek gidemez, test patlar. (Bu dosyayı içe aktaran her test dosyasında geçerli.)
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (girdi) => {
    throw new Error(`İnternet kapalı, izinsiz istek: ${typeof girdi === "string" ? girdi : girdi.url}`);
  });
});

// Sahte Instagram: Worker'ın dışarıya attığı her istek buraya düşer.
// Instagram dışında bir adrese gidilirse test patlar ("internet kapalı"); gerçek Instagram'a hiçbir şey gitmez.
//   videolar: /me/media cevabı (yorumlar ve kapaklar içinde)
//   dm(yorumId): /me/messages cevabı, ör. { status: 400, error: { code: 4 } }; varsayılan başarılı
export function sahteInstagram({ videolar = [], dm = () => ({ status: 200 }), yenileme } = {}) {
  // gidenler: başarılı DM'lerin yorum numaraları · mesajlar: /me/messages'a giden gövdeler · istekler: çağrılan yollar
  const sahte = { videolar, dm, yenileme, gidenler: [], mesajlar: [], istekler: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (girdi, ayar = {}) => {
    const url = new URL(typeof girdi === "string" ? girdi : girdi.url);
    if (url.hostname !== "graph.instagram.com") throw new Error(`İnternet kapalı, izinsiz istek: ${url.href}`);
    sahte.istekler.push(url.pathname);

    if (url.pathname === "/me/media") return Response.json({ data: sahte.videolar });
    if (url.pathname === "/me/messages") {
      const govde = JSON.parse(ayar.body);
      sahte.mesajlar.push(govde);
      const cevap = sahte.dm(govde.recipient.comment_id);
      if (cevap.status === 200) sahte.gidenler.push(govde.recipient.comment_id);
      return Response.json(cevap.error ? { error: cevap.error } : {}, { status: cevap.status });
    }
    if (url.pathname === "/refresh_access_token") {
      const cevap = sahte.yenileme ?? { status: 200, veri: { access_token: "yeni-token", expires_in: 5184000 } };
      return Response.json(cevap.veri ?? {}, { status: cevap.status });
    }
    throw new Error(`Sahte Instagram bu adresi bilmiyor: ${url.pathname}`);
  });
  return sahte;
}

// n dakika önceki zaman, Instagram'ın yazdığı biçimde.
export const dakikaOnce = (n) => new Date(Date.now() - n * 60_000).toISOString().replace("Z", "+0000");

// Kelimeyi yazan bir yorum. kisi: yorum yapanın Instagram numarası.
export const yorum = (id, kisi, dakika, text = "skill") => ({
  id, text, timestamp: dakikaOnce(dakika), username: `kullanici${kisi}`, from: { id: kisi, username: `kullanici${kisi}` },
});

export const video = (id, yorumlar = [], ek = {}) => ({
  id, comments: { data: yorumlar }, caption: `Video ${id}`, thumbnail_url: `https://scontent.cdninstagram.com/${id}.jpg`,
  timestamp: dakikaOnce(60), permalink: `https://www.instagram.com/reel/${id}/`, ...ek,
});

export async function kampanyaKur(kampanyalar) {
  await env.KAYIT.put("kampanyalar", JSON.stringify(kampanyalar));
}

// Dakikalık cron'u bir kez çalıştırır, o dakikada giden DM'leri döndürür.
export async function cron(sahte, zamanlama = "* * * * *") {
  const once = sahte.gidenler.length;
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: zamanlama }), env, ctx);
  await waitOnExecutionContext(ctx);
  return sahte.gidenler.slice(once);
}

export async function kvOku(anahtar) {
  return JSON.parse((await env.KAYIT.get(anahtar)) ?? "null");
}

export async function kvTemizle() {
  const { keys } = await env.KAYIT.list();
  await Promise.all(keys.map((k) => env.KAYIT.delete(k.name)));
}

// Panele istek. Her test kendi IP'sini kullanır ki giriş deneme sınırı testleri birbirini etkilemesin.
let ipSayaci = 0;
export const yeniIp = () => `10.0.0.${++ipSayaci}`;

export async function istek(yol, { method = "GET", cerez, ip = "10.9.9.9", origin, govde, form } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (cerez) headers.Cookie = cerez;
  if (origin) headers.Origin = origin;
  let body;
  if (form) body = new URLSearchParams(form);
  if (govde !== undefined) {
    headers["Content-Type"] = "application/json";
    body = typeof govde === "string" ? govde : JSON.stringify(govde);
  }
  const ctx = createExecutionContext();
  const cevap = await worker.fetch(new Request(`${ADRES}${yol}`, { method, headers, body, redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return cevap;
}

// Test şifresiyle giriş yapar, oturum çerezini ("ad=değer") döndürür.
export async function girisYap() {
  const cevap = await istek("/giris", { method: "POST", ip: yeniIp(), form: { kullanici: "test", sifre: env.TEST_SIFRESI } });
  return cevap.headers.get("Set-Cookie").split(";")[0];
}
