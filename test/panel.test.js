// Panel API'si (/api/durum, /api/kampanya), panelle cron'un uçtan uca bağı ve gece token yenileme.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { ADRES, sahteInstagram, yorum, video, kampanyaKur, cron, istek, girisYap, kvOku, kvTemizle } from "./yardimci.js";

beforeEach(kvTemizle);
afterEach(() => vi.restoreAllMocks());

const kaydet = async (cerez, govde) => istek("/api/kampanya", { method: "POST", cerez, origin: ADRES, govde });

describe("/api/durum", () => {
  it("videoları kapak ve linkleriyle, kampanyaları, DM ve sıra sayılarını verir", async () => {
    await kampanyaKur({ v1: { aktif: true, kelime: "skill", mesaj: "m" }, v2: { aktif: false, kelime: "x", mesaj: "m" } });
    await env.KAYIT.put("dm:v1", JSON.stringify({ bitti: ["a", "b"], kisiler: ["A", "B"], deneme: {} }));
    await env.KAYIT.put("musluk", JSON.stringify({
      gun: new Date().toISOString().slice(0, 10), bugun: 2,
      kuyruk: [{ v: "v1", y: "c", k: "C", t: "x" }, { v: "v2", y: "d", k: "D", t: "x" }],
    }));
    sahteInstagram({ videolar: [video("v1"), video("v2")] });

    const veri = await (await istek("/api/durum", { cerez: await girisYap() })).json();
    expect(veri.videolar.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(veri.videolar[0]).toMatchObject({ kapak: "https://scontent.cdninstagram.com/v1.jpg", link: "https://www.instagram.com/reel/v1/" });
    expect(veri.sayilar).toEqual({ v1: 2 }); // pasif videonun sayısı verilmez
    expect(veri.musluk.sirada).toEqual({ v1: 1 }); // pasif videonun sırası sayılmaz
    expect(veri.musluk.bugun).toBe(2);
    expect(veri.musluk.dakikadaDm).toBe(2);
  });

  it("dünkü DM sayısı bugüne taşınmaz", async () => {
    await env.KAYIT.put("musluk", JSON.stringify({ gun: "2000-01-01", bugun: 50, kuyruk: [] }));
    sahteInstagram();
    const veri = await (await istek("/api/durum", { cerez: await girisYap() })).json();
    expect(veri.musluk.bugun).toBe(0);
  });

  it("token'ın kalan gününü hesaplar; tarih yoksa 'bilinmiyor' (null)", async () => {
    sahteInstagram();
    const cerez = await girisYap();
    expect((await (await istek("/api/durum", { cerez })).json()).token).toEqual({ kalanGun: null, hata: null });
    await env.KAYIT.put("token_tarih", String(Date.now() - 17.5 * 86400000)); // 42,5 gün kaldı → 42
    expect((await (await istek("/api/durum", { cerez })).json()).token.kalanGun).toBe(42);
  });

  it("Instagram hata verirse panel çökmez, token sorununu bildirir", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: 190, message: "token geçersiz" } }, { status: 400 }));
    const cevap = await istek("/api/durum", { cerez: await girisYap() });
    expect(cevap.status).toBe(200);
    const veri = await cevap.json();
    expect(veri.videolar).toEqual([]);
    expect(veri.token.hata).toContain("token geçersiz");
  });
});

describe("/api/kampanya", () => {
  it("kaydeder; boş ve pasif kayıt silinir", async () => {
    const cerez = await girisYap();
    const cevap = await kaydet(cerez, { video: "123", aktif: true, kelime: " SKİLL ", mesaj: "Selam! İşte: ığüşöç" });
    expect(cevap.status).toBe(200);
    expect(await kvOku("kampanyalar")).toEqual({ 123: { aktif: true, kelime: "SKİLL", mesaj: "Selam! İşte: ığüşöç" } });

    await kaydet(cerez, { video: "123", aktif: false, kelime: "", mesaj: "" });
    expect(await kvOku("kampanyalar")).toEqual({});
  });

  it("diğer videoların kampanyalarına dokunmaz", async () => {
    await kampanyaKur({ 111: { aktif: true, kelime: "a", mesaj: "b" } });
    await kaydet(await girisYap(), { video: "222", aktif: true, kelime: "c", mesaj: "d" });
    expect(Object.keys(await kvOku("kampanyalar")).sort()).toEqual(["111", "222"]);
  });

  it("bozuk ya da eksik veriyi reddeder, KV'ye yazmaz", async () => {
    const cerez = await girisYap();
    const bozuklar = [
      { video: "abc", aktif: false },
      { video: "../kampanyalar", aktif: false },
      { video: "1".repeat(31), aktif: false },
      { video: "123", aktif: true, kelime: "", mesaj: "m" },
      { video: "123", aktif: true, kelime: "k", mesaj: "" },
      { video: "123", aktif: true, kelime: "k".repeat(51), mesaj: "m" },
      { video: "123", aktif: true, kelime: "k", mesaj: "m".repeat(1001) },
      "{bozuk json",
      null,
    ];
    for (const govde of bozuklar) {
      const cevap = await kaydet(cerez, govde);
      expect(cevap.status, JSON.stringify(govde)).toBe(400);
      expect((await cevap.json()).hata).toBeTruthy();
    }
    expect(await kvOku("kampanyalar")).toBeNull();
  });

  it("aktif: 'true' gibi yazıyla gelen değer aktif sayılmaz", async () => {
    await kaydet(await girisYap(), { video: "123", aktif: "true", kelime: "k", mesaj: "m" });
    expect((await kvOku("kampanyalar"))["123"].aktif).toBe(false);
  });
});

describe("panel → cron uçtan uca", () => {
  it("panelde aktif yapılan videoya cron DM atar, pasif yapınca durur", async () => {
    const cerez = await girisYap();
    const ig = sahteInstagram({ videolar: [video("555", [yorum("a", "A", 3, "panelTest")])] });

    await kaydet(cerez, { video: "555", aktif: true, kelime: "paneltest", mesaj: "Merhaba" });
    expect(await cron(ig)).toEqual(["a"]);

    await kaydet(cerez, { video: "555", aktif: false, kelime: "paneltest", mesaj: "Merhaba" });
    ig.videolar[0].comments.data.push(yorum("b", "B", 1, "PANELTEST"));
    expect(await cron(ig)).toEqual([]);
    expect(ig.istekler.filter((y) => y === "/me/messages")).toHaveLength(1);
  });

  it("DM'e panelde yazılan mesaj gider", async () => {
    const cerez = await girisYap();
    const ig = sahteInstagram({ videolar: [video("555", [yorum("a", "A", 1)])] });
    await kaydet(cerez, { video: "555", aktif: true, kelime: "skill", mesaj: "İşte dosyan 🎁" });
    await cron(ig);
    expect(ig.mesajlar).toEqual([{ recipient: { comment_id: "a" }, message: { text: "İşte dosyan 🎁" } }]);
  });
});

describe("gece token yenileme", () => {
  const GECE = "0 3 * * *";

  it("7 günden eski token'ı yeniler ve KV'ye yazar", async () => {
    await env.KAYIT.put("token_tarih", String(Date.now() - 8 * 86400000));
    const ig = sahteInstagram();
    await cron(ig, GECE);
    expect(ig.istekler).toEqual(["/refresh_access_token"]);
    expect(await env.KAYIT.get("token")).toBe("yeni-token");
  });

  it("taze token'a dokunmaz", async () => {
    await env.KAYIT.put("token_tarih", String(Date.now() - 2 * 86400000));
    const ig = sahteInstagram();
    await cron(ig, GECE);
    expect(ig.istekler).toEqual([]);
  });

  it("yenileme başarısızsa eski token'ı korur", async () => {
    await env.KAYIT.put("token", "eski-token");
    await env.KAYIT.put("token_tarih", String(Date.now() - 8 * 86400000));
    const ig = sahteInstagram({ yenileme: { status: 400, veri: { error: { message: "olmadı" } } } });
    await cron(ig, GECE);
    expect(await env.KAYIT.get("token")).toBe("eski-token");
  });

  it("gece işi kimseye DM atmaz", async () => {
    await kampanyaKur({ v1: { aktif: true, kelime: "skill", mesaj: "m" } });
    await env.KAYIT.put("token_tarih", String(Date.now()));
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 1)])] });
    expect(await cron(ig, GECE)).toEqual([]);
  });
});
