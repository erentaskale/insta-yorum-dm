// Panelin tarayıcı kodu: /api/durum'dan veriyi alır, listeyi ve ayar kutusunu çizer,
// "Kaydet"te /api/kampanya'ya yollar. Instagram'dan gelen yazılar hep textContent ile basılır (innerHTML yok).

const durum = { videolar: [], kampanyalar: {}, sayilar: {}, musluk: { sirada: {}, bugun: 0, dakikadaDm: 2 }, secili: null };

const $ = (id) => document.getElementById(id);

yukle();

async function yukle() {
  const cevap = await fetch("/api/durum");
  if (cevap.status === 401) return location.reload(); // Oturum bitti: giriş sayfasına dön.
  const veri = await cevap.json();
  Object.assign(durum, veri);

  ozetCiz();
  if (veri.token.hata) uyar(`Instagram'a ulaşılamadı, token'da sorun olabilir: ${veri.token.hata}`);
  else if (veri.token.kalanGun !== null && veri.token.kalanGun <= 10) {
    uyar(`Token ${veri.token.kalanGun} gün içinde bitiyor ve kendini yenileyemedi. Loglara bak.`);
  }
  listeCiz();
}

function ozetCiz() {
  const aktifler = Object.keys(durum.kampanyalar).filter((id) => durum.kampanyalar[id].aktif);
  $("toplam").textContent = aktifler.reduce((top, id) => top + (durum.sayilar[id] ?? 0), 0);
  $("aktifSayi").textContent = aktifler.length;
  $("bugun").textContent = durum.musluk.bugun;

  // Pasif yapılan videonun sırası sayılmaz (bekler, gönderilmez).
  const sirada = aktifler.reduce((top, id) => top + (durum.musluk.sirada[id] ?? 0), 0);
  $("sirada").textContent = sirada === 0 ? "0" : `${sirada} kişi · ~${beklemeDk(sirada)} dk`;

  const { kalanGun, hata } = durum.token;
  $("token").textContent = hata ? "Sorun var" : kalanGun === null ? "Çalışıyor" : `${kalanGun} gün`;
  $("tokenKarti").classList.toggle("mavi", !hata);
  $("tokenKarti").classList.toggle("kirmizi", Boolean(hata));
}

function uyar(yazi) {
  $("uyari").textContent = yazi;
  $("uyari").hidden = false;
}

function listeCiz() {
  const liste = $("liste");
  liste.replaceChildren();
  if (durum.videolar.length === 0) {
    const bos = document.createElement("li");
    bos.className = "bos";
    bos.textContent = durum.token.hata ? "Videolar alınamadı." : "Hesapta video yok.";
    liste.append(bos);
    return;
  }

  for (const video of durum.videolar) {
    const satir = $("satirSablonu").content.cloneNode(true);
    const buton = satir.querySelector(".satir");
    resimKoy(satir.querySelector("img"), video.kapak);
    satir.querySelector(".aciklama").textContent = `${tarih(video.tarih)} · ${ilkSatir(video.aciklama)}`;

    const etiket = satir.querySelector(".etiket");
    const kampanya = durum.kampanyalar[video.id];
    if (kampanya?.aktif) {
      const sira = durum.musluk.sirada[video.id];
      etiket.textContent = `Aktif · ${kampanya.kelime} · ${durum.sayilar[video.id] ?? 0} DM${sira ? ` · ${sira} sırada` : ""}`;
      etiket.classList.add("aktif");
    } else {
      etiket.textContent = kampanya ? `Pasif · ${kampanya.kelime}` : "Pasif";
    }

    buton.classList.toggle("secili", video.id === durum.secili);
    buton.addEventListener("click", () => sec(video.id));
    liste.append(satir);
  }
}

function sec(id) {
  durum.secili = id;
  listeCiz();
  ayarCiz();
  // Telefonda ayar kutusu listenin altında; seçince oraya kaydır.
  if (window.matchMedia("(max-width: 760px)").matches) $("ayar").scrollIntoView({ behavior: "smooth" });
}

function ayarCiz() {
  const video = durum.videolar.find((v) => v.id === durum.secili);
  const kampanya = durum.kampanyalar[video.id] ?? { aktif: false, kelime: "", mesaj: "" };
  const kutu = $("ayarSablonu").content.cloneNode(true);
  const form = kutu.querySelector("form");

  resimKoy(kutu.querySelector("img"), video.kapak);
  kutu.querySelector(".aciklama").textContent = video.aciklama || "Açıklamasız video";
  kutu.querySelector(".dm").textContent = dmYazisi(video, kampanya);
  kutu.querySelector(".link").href = video.link;
  form.aktif.checked = kampanya.aktif;
  form.kelime.value = kampanya.kelime;
  form.mesaj.value = kampanya.mesaj;

  form.addEventListener("submit", (olay) => {
    olay.preventDefault();
    kaydet(form, video.id);
  });
  // Bir şey değişince eski "Kaydedildi" yazısı kalksın.
  form.addEventListener("input", () => (form.querySelector(".sonuc").hidden = true));

  $("ayar").replaceChildren(kutu);
}

function dmYazisi(video, kampanya) {
  if (!kampanya?.aktif) return `${tarih(video.tarih)} tarihli video.`;
  const sira = durum.musluk.sirada[video.id] ?? 0;
  return `Son 30 günde ${durum.sayilar[video.id] ?? 0} kişiye DM gitti.` +
    (sira ? ` ${sira} kişi sırada, en geç ~${beklemeDk(sira)} dk.` : "");
}

async function kaydet(form, id) {
  const hata = form.querySelector(".hata");
  const sonuc = form.querySelector(".sonuc");
  const buton = form.querySelector(".kaydet");
  hata.hidden = true;
  sonuc.hidden = true;

  const veri = {
    video: id,
    aktif: form.aktif.checked,
    kelime: form.kelime.value.trim(),
    mesaj: form.mesaj.value.trim(),
  };
  if (veri.aktif && (!veri.kelime || !veri.mesaj)) {
    hata.textContent = "Aktif yapmak için altın kelimeyi ve mesajı yaz.";
    hata.hidden = false;
    return;
  }

  buton.disabled = true;
  buton.textContent = "Kaydediliyor…";
  try {
    const cevap = await fetch("/api/kampanya", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(veri),
    });
    if (cevap.status === 401) return location.reload();
    const sonucVerisi = await cevap.json();
    if (!cevap.ok) throw new Error(sonucVerisi.hata ?? "Kaydedilemedi.");

    if (sonucVerisi.kampanya) durum.kampanyalar[id] = sonucVerisi.kampanya;
    else delete durum.kampanyalar[id];
    ozetCiz();
    listeCiz();
    const video = durum.videolar.find((v) => v.id === id);
    form.querySelector(".dm").textContent = dmYazisi(video, durum.kampanyalar[id]);
    sonuc.textContent = veri.aktif ? "Kaydedildi. Bir dakika içinde devreye girer." : "Kaydedildi.";
    sonuc.hidden = false;
  } catch (e) {
    hata.textContent = e.message === "Failed to fetch" ? "Bağlantı yok, tekrar dene." : e.message;
    hata.hidden = false;
  } finally {
    buton.disabled = false;
    buton.textContent = "Kaydet";
  }
}

// Kapak yoksa ya da Instagram'ın geçici adresi süresi dolduysa gri kutu kalsın.
function resimKoy(img, adres) {
  if (adres) img.src = adres;
  img.addEventListener("error", () => img.removeAttribute("src"));
}

// Musluk dakikada dakikadaDm kişiye DM atar: sıradaki son kişi kaç dakika bekler?
// (Sıra bütün videolar için ortak; video bazında sayı kabaca bir üst sınırdır.)
function beklemeDk(kisi) {
  return Math.ceil(kisi / durum.musluk.dakikadaDm);
}

function tarih(metin) {
  return new Date(metin).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
}

function ilkSatir(yazi) {
  return (yazi || "Açıklamasız video").split("\n")[0];
}
