// Cron'un ve panelin ortak kullandığı Instagram ve KV bilgileri.

export const API = "https://graph.instagram.com";

// Tek istekte son kaç video çekilecek. Cron da panel de aynı pencereye bakar:
// panelde görünmeyen video aktif yapılamaz, aktif video da cron'un gözünden kaçmaz.
// Instagram çoklu video isteğini (?ids=) kaldırdı; aktif videoyu bu pencerenin içinde ararız.
export const VIDEO_SAYISI = 25;

// Musluk (rate limiting): dakikada en fazla 2 DM, günde en fazla 1.000 (KV yazma hakkı da günde 1.000).
// Neden 2: Meta saatte ~200 istek veriyor. Kuyruk doluyken saatte 60 okuma + 120 DM = 180, panele de pay kalır.
// (3 olsaydı 240 olurdu; DM'lerin bu sınıra sayılıp sayılmadığı doğrulanmadı, güvenli taraftayız.)
// Örnek: 300 kişi → son kişi ~150 dk sonra alır. Limite yine çarparsak kimse kaybolmaz:
// musluk o dakika durur, sonraki dakika kaldığı yerden devam eder.
export const DAKIKADA_DM = 2;
export const GUNLUK_TAVAN = 1000;

// Token 60 gün geçerli; gece cron'u 7 günde bir yeniler.
export const TOKEN_OMRU_MS = 60 * 24 * 60 * 60 * 1000;

// Kullanılacak token: KV'deki yenilenmiş olan, yoksa ilk yüklenen secret.
export async function tokenAl(env) {
  return (await env.KAYIT.get("token")) ?? env.IG_TOKEN;
}

// Panelin kaydettiği bütün kampanyalar: { "<video id>": { aktif, kelime, mesaj } }
export async function kampanyalariOku(env) {
  return JSON.parse((await env.KAYIT.get("kampanyalar")) ?? "{}");
}

// Videonun DM kaydı (KV'de `dm:<video id>`): işi biten yorumlar, DM alan kişiler, deneme sayıları.
// Eski sürümlerin kayıtlarını da anlar (ilki düz liste yazıyordu, ikincisinde kisiler yoktu).
export function kayitOku(metin) {
  const veri = JSON.parse(metin ?? "null");
  if (Array.isArray(veri)) return { bitti: veri, kisiler: [], deneme: {} };
  return { bitti: veri?.bitti ?? [], kisiler: veri?.kisiler ?? [], deneme: veri?.deneme ?? {} };
}

// Musluğun durumu (KV'de `musluk`): DM bekleyenlerin sırası ve bugün giden DM sayısı.
//   kuyruk: [{ v: video id, y: yorum id, k: kişi id, t: yorum zamanı }], ilk yazan önde
export function muslukOku(metin) {
  const veri = JSON.parse(metin ?? "null");
  return { gun: veri?.gun ?? "", bugun: veri?.bugun ?? 0, kuyruk: veri?.kuyruk ?? [] };
}

// Instagram'a GET isteği; hata olursa Instagram'ın mesajıyla birlikte fırlatır.
export async function instagramdanAl(token, yol) {
  const cevap = await fetch(`${API}${yol}`, { headers: { Authorization: `Bearer ${token}` } });
  const veri = await cevap.json().catch(() => ({}));
  if (!cevap.ok) {
    throw new Error(`Instagram hata verdi (${cevap.status}): ${JSON.stringify(veri.error ?? veri)}`);
  }
  return veri;
}
