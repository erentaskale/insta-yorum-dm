// Dakikalık cron: kuyruk (FIFO), musluk (dakikada 2 DM), kişi başına tek DM, hata türleri.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sahteInstagram, yorum, video, kampanyaKur, cron, kvOku, kvTemizle } from "./yardimci.js";

const AKTIF = { aktif: true, kelime: "skill", mesaj: "İşte link" };

beforeEach(kvTemizle);
afterEach(() => vi.restoreAllMocks());

describe("kuyruk ve musluk", () => {
  it("dakikada en fazla 2 DM atar, ilk yazan önce alır (iki video karışık)", async () => {
    await kampanyaKur({ v1: AKTIF, v2: AKTIF });
    const ig = sahteInstagram({
      videolar: [
        video("v1", [yorum("a", "A", 10), yorum("c", "C", 8), yorum("e", "E", 6)]),
        video("v2", [yorum("b", "B", 9), yorum("d", "D", 7)]),
      ],
    });
    expect(await cron(ig)).toEqual(["a", "b"]);
    expect(await cron(ig)).toEqual(["c", "d"]);
    expect(await cron(ig)).toEqual(["e"]);
    expect((await kvOku("musluk")).kuyruk).toHaveLength(0);
    expect((await kvOku("musluk")).bugun).toBe(5);
  });

  it("son 50 yorumun dışına düşen kişiyi unutmaz", async () => {
    await kampanyaKur({ v1: AKTIF });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 4), yorum("b", "B", 3), yorum("c", "C", 2)])] });
    expect(await cron(ig)).toEqual(["a", "b"]);
    ig.videolar = [video("v1", [])]; // Instagram artık o yorumları göstermiyor
    expect(await cron(ig)).toEqual(["c"]);
  });

  it("aynı kişi kaç kez yazarsa yazsın o videodan tek DM alır", async () => {
    await kampanyaKur({ v1: AKTIF });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a1", "A", 5), yorum("a2", "A", 4), yorum("a3", "A", 3)])] });
    expect(await cron(ig)).toEqual(["a1"]);
    ig.videolar[0].comments.data.push(yorum("a4", "A", 1));
    expect(await cron(ig)).toEqual([]);
  });

  it("aynı kişi farklı videodan ayrıca DM alır", async () => {
    await kampanyaKur({ v1: AKTIF, v2: AKTIF });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a1", "A", 5)]), video("v2", [yorum("a2", "A", 4)])] });
    expect(await cron(ig)).toEqual(["a1", "a2"]);
  });

  it("Meta limit hatası (400 + kod 4) deneme hakkı yemez, o dakika durur, sonra devam eder", async () => {
    await kampanyaKur({ v1: AKTIF });
    let limitVar = true;
    const ig = sahteInstagram({
      videolar: [video("v1", [yorum("a", "A", 5), yorum("b", "B", 4), yorum("c", "C", 3)])],
      dm: (id) => (limitVar && id === "b" ? { status: 400, error: { code: 4, message: "limit" } } : { status: 200 }),
    });
    expect(await cron(ig)).toEqual(["a"]);
    expect((await kvOku("musluk")).kuyruk.map((s) => s.y)).toEqual(["b", "c"]);
    expect((await kvOku("dm:v1")).deneme).toEqual({});
    limitVar = false;
    expect(await cron(ig)).toEqual(["b", "c"]);
  });

  it("429 de limit sayılır", async () => {
    await kampanyaKur({ v1: AKTIF });
    let limitVar = true;
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 5)])], dm: () => (limitVar ? { status: 429 } : { status: 200 }) });
    expect(await cron(ig)).toEqual([]);
    limitVar = false;
    expect(await cron(ig)).toEqual(["a"]);
  });

  it("kalıcı hata sıradan düşer; Instagram 500'ü 3 denemeden sonra bırakılır", async () => {
    await kampanyaKur({ v1: AKTIF });
    const ig = sahteInstagram({
      videolar: [video("v1", [yorum("k", "K", 5), yorum("s", "S", 4)])],
      dm: (id) => (id === "k" ? { status: 400, error: { code: 10 } } : { status: 500 }),
    });
    for (let i = 0; i < 3; i++) await cron(ig);
    expect((await kvOku("musluk")).kuyruk).toHaveLength(0);
    expect((await kvOku("dm:v1")).bitti.sort()).toEqual(["k", "s"]);
    await cron(ig);
    expect(ig.istekler.filter((y) => y === "/me/messages")).toHaveLength(4); // k: 1, s: 3
  });

  it("pasif videonun sırası bekler, hak yemez; tekrar aktif olunca gider", async () => {
    await kampanyaKur({ v1: AKTIF, v2: AKTIF });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 9)]), video("v2", [yorum("b", "B", 5), yorum("c", "C", 4)])] });
    ig.dm = () => ({ status: 429 }); // ilk dakika kimse almasın, ikisi de sıraya girsin
    await cron(ig);
    ig.dm = () => ({ status: 200 });
    await kampanyaKur({ v1: { ...AKTIF, aktif: false }, v2: AKTIF });
    expect(await cron(ig)).toEqual(["b", "c"]); // v1'in 'a'sı en önde ama pasif: atlanır
    await kampanyaKur({ v1: AKTIF, v2: AKTIF });
    expect(await cron(ig)).toEqual(["a"]);
  });

  it("7 günü geçen yorum hem sıraya girmez hem sıradan düşer", async () => {
    await kampanyaKur({ v1: AKTIF });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("eski", "E", 8 * 24 * 60)])] });
    const { env } = await import("cloudflare:test");
    await env.KAYIT.put("musluk", JSON.stringify({ gun: "", bugun: 0, kuyruk: [{ v: "v1", y: "sirada-eski", k: "Z", t: yorum("x", "Z", 8 * 24 * 60).timestamp }] }));
    expect(await cron(ig)).toEqual([]);
    expect((await kvOku("musluk")).kuyruk).toHaveLength(0);
  });

  it("günlük 1.000 DM tavanında durur", async () => {
    await kampanyaKur({ v1: AKTIF });
    const { env } = await import("cloudflare:test");
    const bugun = new Date().toISOString().slice(0, 10);
    await env.KAYIT.put("musluk", JSON.stringify({ gun: bugun, bugun: 999, kuyruk: [] }));
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 3), yorum("b", "B", 2)])] });
    expect(await cron(ig)).toEqual(["a"]);
    expect(await cron(ig)).toEqual([]);
    expect((await kvOku("musluk")).kuyruk).toHaveLength(1);
  });
});

describe("eşleşme", () => {
  it("büyük/küçük harf ve ı/i, İ farkını önemsemez; kelimenin geçmesi yeter", async () => {
    await kampanyaKur({ v1: AKTIF });
    const ig = sahteInstagram({
      videolar: [video("v1", [yorum("a", "A", 5, "SKİLL lütfen"), yorum("b", "B", 4, "skıll"), yorum("c", "C", 3, "selam")])],
    });
    expect(await cron(ig)).toEqual(["a", "b"]);
    expect(await cron(ig)).toEqual([]);
  });

  it("kendi hesabımızın yorumuna DM atmaz", async () => {
    await kampanyaKur({ v1: AKTIF });
    const kendi = { ...yorum("k", "BIZ", 2), username: "yager.dev" };
    const ig = sahteInstagram({ videolar: [video("v1", [kendi])] });
    expect(await cron(ig)).toEqual([]);
  });
});

describe("test ortamının kendisi", () => {
  it("sahte Instagram kurulmadıysa hiçbir istek dışarı çıkamaz", async () => {
    await kampanyaKur({ v1: AKTIF });
    const { env, createScheduledController, createExecutionContext } = await import("cloudflare:test");
    const worker = (await import("../src/index.js")).default;
    await expect(worker.scheduled(createScheduledController({ cron: "* * * * *" }), env, createExecutionContext()))
      .rejects.toThrow("İnternet kapalı");
  });
});

describe("istek ve yazma tasarrufu", () => {
  it("aktif kampanya yoksa Instagram'a hiç istek atmaz", async () => {
    await kampanyaKur({ v1: { ...AKTIF, aktif: false } });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 1)])] });
    await cron(ig);
    expect(ig.istekler).toEqual([]);
  });

  it("boş dakikada KV'ye yazmaz", async () => {
    await kampanyaKur({ v1: AKTIF });
    const ig = sahteInstagram({ videolar: [video("v1", [yorum("a", "A", 1)])] });
    await cron(ig);
    const { env } = await import("cloudflare:test");
    const yaz = vi.spyOn(env.KAYIT, "put");
    await cron(ig);
    expect(yaz).not.toHaveBeenCalled();
  });
});
