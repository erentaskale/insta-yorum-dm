// Panelin kapısı: giriş, oturum çerezi, deneme sınırı, güvenlik başlıkları, saldırı denemeleri.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index.js";
import PANEL_JS from "../src/tarayici/panel.js";
import { ADRES, sahteInstagram, video, istek, girisYap, yeniIp, kvTemizle, kvOku } from "./yardimci.js";

beforeEach(kvTemizle);
afterEach(() => vi.restoreAllMocks());

const giris = (kullanici, sifre, ip = yeniIp()) => istek("/giris", { method: "POST", ip, form: { kullanici, sifre } });

describe("giriş", () => {
  it("girişsiz ana sayfa yalnız giriş formunu gösterir", async () => {
    const cevap = await istek("/");
    const html = await cevap.text();
    expect(cevap.status).toBe(200);
    expect(html).toContain('action="/giris"');
    expect(html).not.toContain("/panel.js");
  });

  it("doğru bilgiyle giriş güvenli bir çerez verir ve panele yönlendirir", async () => {
    const cevap = await giris("test", env.TEST_SIFRESI);
    expect(cevap.status).toBe(303);
    expect(cevap.headers.get("Location")).toBe("/");
    const cerez = cevap.headers.get("Set-Cookie");
    expect(cerez).toMatch(/^__Host-oturum=/);
    for (const bayrak of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(cerez).toContain(bayrak);
  });

  it("yanlış şifre ve yanlış kullanıcı adı reddedilir, çerez verilmez", async () => {
    for (const [k, s] of [["test", "yanlis-sifre"], ["baskasi", env.TEST_SIFRESI], ["", ""]]) {
      const cevap = await giris(k, s);
      expect(cevap.status).toBe(401);
      expect(cevap.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("aynı IP'den dakikada 5'ten fazla deneme engellenir (doğru şifre bile)", async () => {
    const ip = yeniIp();
    for (let i = 0; i < 5; i++) expect((await giris("test", "yanlis", ip)).status).toBe(401);
    expect((await giris("test", env.TEST_SIFRESI, ip)).status).toBe(429);
    // Başka IP etkilenmez
    expect((await giris("test", env.TEST_SIFRESI)).status).toBe(303);
  });

  it("deneme sayacı KV'ye yazmaz (DM kayıtlarının yazma hakkını tüketmesin)", async () => {
    const yaz = vi.spyOn(env.KAYIT, "put");
    await giris("test", "yanlis");
    expect(yaz).not.toHaveBeenCalled();
  });

  it("şifre secret'ı yoksa ya da bozuksa kimse giremez", async () => {
    for (const bozuk of [undefined, "", "duz-sifre", "pbkdf2$100000$$"]) {
      const env2 = { ...env, PANEL_SIFRE_HASH: bozuk };
      const cevap = await worker.fetch(
        new Request(`${ADRES}/giris`, { method: "POST", headers: { "CF-Connecting-IP": yeniIp() }, body: new URLSearchParams({ kullanici: "test", sifre: "" }) }),
        env2
      );
      expect(cevap.status).toBe(401);
    }
  });

  it("çıkış çerezi siler", async () => {
    const cevap = await istek("/cikis", { method: "POST", cerez: await girisYap() });
    expect(cevap.status).toBe(303);
    expect(cevap.headers.get("Set-Cookie")).toMatch(/__Host-oturum=;.*Max-Age=0/);
  });
});

describe("oturum çerezi", () => {
  it("geçerli çerezle panel açılır", async () => {
    const html = await (await istek("/", { cerez: await girisYap() })).text();
    expect(html).toContain("/panel.js");
  });

  it("sahte, değiştirilmiş ya da süresi geçmiş çerez reddedilir", async () => {
    const gercek = await girisYap();
    const [bitis, imza] = gercek.split("=")[1].split(".");
    const sahteler = [
      "__Host-oturum=9999999999.sahteimza",
      `__Host-oturum=${Number(bitis) + 1000}.${imza}`, // süre uzatılmış, imza eski
      `__Host-oturum=${bitis}.${imza.slice(0, -2)}xx`, // imza bozulmuş
      `__Host-oturum=${Math.floor(Date.now() / 1000) - 10}.${imza}`, // süresi geçmiş
      "__Host-oturum=",
      "baska-cerez=1",
    ];
    for (const cerez of sahteler) {
      expect((await istek("/api/durum", { cerez })).status).toBe(401);
      expect(await (await istek("/", { cerez })).text()).not.toContain("/panel.js");
    }
  });

  it("başka anahtarla imzalanmış çerez geçmez (oturum anahtarı değişince herkes çıkar)", async () => {
    const cerez = await girisYap();
    const cevap = await worker.fetch(
      new Request(`${ADRES}/api/durum`, { headers: { Cookie: cerez } }),
      { ...env, OTURUM_ANAHTARI: "yeni-anahtar" }
    );
    expect(cevap.status).toBe(401);
  });
});

describe("girişsiz erişim ve saldırılar", () => {
  it("girişsiz API ve tarayıcı kodu kapalı", async () => {
    expect((await istek("/api/durum")).status).toBe(401);
    expect((await istek("/panel.js")).status).toBe(401);
    expect((await istek("/api/kampanya", { method: "POST", origin: ADRES, govde: { video: "1", aktif: false } })).status).toBe(401);
  });

  it("girişsiz kayıt denemesi KV'ye hiçbir şey yazmaz", async () => {
    await istek("/api/kampanya", { method: "POST", origin: ADRES, govde: { video: "123", aktif: true, kelime: "x", mesaj: "y" } });
    expect(await kvOku("kampanyalar")).toBeNull();
  });

  it("başka siteden gelen kayıt isteği (CSRF) reddedilir", async () => {
    const cerez = await girisYap();
    const govde = { video: "123", aktif: true, kelime: "x", mesaj: "y" };
    expect((await istek("/api/kampanya", { method: "POST", cerez, govde })).status).toBe(403);
    expect((await istek("/api/kampanya", { method: "POST", cerez, govde, origin: "https://kotu.site" })).status).toBe(403);
    expect(await kvOku("kampanyalar")).toBeNull();
  });

  it("bilinmeyen adresler, dosya ve sır avı 404 döner; token hiçbir cevapta yok", async () => {
    const cerez = await girisYap();
    for (const yol of ["/wrangler.toml", "/.dev.vars", "/src/index.js", "/../ig-token.txt", "/api", "/api/token", "/admin"]) {
      const cevap = await istek(yol, { cerez });
      expect(cevap.status).toBe(404);
      expect(await cevap.text()).not.toContain("sahte-token");
    }
  });

  it("panel API cevabında token, şifre özeti ya da oturum anahtarı yok", async () => {
    sahteInstagram({ videolar: [video("v1")] });
    const metin = await (await istek("/api/durum", { cerez: await girisYap() })).text();
    for (const sir of ["sahte-token", env.PANEL_SIFRE_HASH, env.OTURUM_ANAHTARI]) expect(metin).not.toContain(sir);
  });

  it("giriş hatası mesajına kullanıcı girdisi basılmaz (XSS)", async () => {
    const html = await (await giris("<script>alert(1)</script>", "x")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("tarayıcı kodu Instagram'dan gelen yazıyı HTML olarak basmaz (innerHTML yok)", () => {
    const kod = PANEL_JS.replace(/\/\/.*$/gm, ""); // yorum satırları sayılmaz
    expect(kod).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("her cevapta güvenlik başlıkları var", async () => {
    const cerez = await girisYap();
    sahteInstagram({ videolar: [] });
    for (const cevap of [await istek("/"), await istek("/", { cerez }), await istek("/api/durum", { cerez }), await istek("/yok")]) {
      const csp = cevap.headers.get("Content-Security-Policy");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(cevap.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(cevap.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
