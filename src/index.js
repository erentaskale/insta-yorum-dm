// insta-yorum-dm: dakikada bir son videoların yorumlarını okur.
// Faz 3: yalnız okuyup yeni yorumları loga yazar, DM atmaz.

const API = "https://graph.instagram.com";

// Son kaç videoya bakılacak ve video başına kaç yorum okunacak.
const VIDEO_SAYISI = 5;
const YORUM_SAYISI = 50;

// Cron dakikada bir çalışır; son 2 dakikadaki yorumları "yeni" sayarız (arada kaçan olmasın diye 1 dk pay).
const YENI_SAYILMA_SURESI_MS = 2 * 60 * 1000;

export default {
  // Cloudflare bu fonksiyonu wrangler.toml'daki cron'a göre çağırır.
  async scheduled(event, env, ctx) {
    const videolar = await sonVideolar(env.IG_TOKEN);
    const simdi = Date.now();

    for (const video of videolar) {
      const yorumlar = video.comments?.data ?? [];
      for (const yorum of yorumlar) {
        const yas = simdi - new Date(yorum.timestamp).getTime();
        if (yas <= YENI_SAYILMA_SURESI_MS) {
          console.log(`Yeni yorum | video ${video.id} | yorum ${yorum.id} | "${yorum.text}"`);
        }
      }
    }
    console.log(`Kontrol bitti: ${videolar.length} video okundu.`);
  },
};

// Tek istekte son videoları yorumlarıyla birlikte ister (saatte 200 istek sınırı için).
async function sonVideolar(token) {
  const alanlar = `id,permalink,comments.limit(${YORUM_SAYISI}){id,text,timestamp}`;
  const adres = `${API}/me/media?fields=${encodeURIComponent(alanlar)}&limit=${VIDEO_SAYISI}`;

  const cevap = await fetch(adres, { headers: { Authorization: `Bearer ${token}` } });
  const veri = await cevap.json();

  if (!cevap.ok) {
    throw new Error(`Instagram hata verdi (${cevap.status}): ${JSON.stringify(veri.error ?? veri)}`);
  }
  return veri.data ?? [];
}
