// Panel giriş bilgilerini Cloudflare'e yükler: `npm run sifre`
//
// Kullanıcı adı ve şifre sorulur (şifre ekranda görünmez). Şifre boş bırakılırsa rastgele bir tane üretilip
// bir kez ekrana yazılır. Şifrenin kendisi hiçbir yere kaydedilmez;
// Cloudflare'e yalnız PBKDF2 özeti gider. Her çalıştırmada yeni bir oturum anahtarı da üretilir,
// yani açık olan bütün panel oturumları kapanır.

import { spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

// Cloudflare Workers PBKDF2'de en fazla 100.000 tura izin veriyor; src/panel.js aynı ayarla doğrular.
const TUR = 100_000;
// Giriş denemesi dakikada 5 ile sınırlı; 12 rastgele karakteri bu hızla tahmin etmek imkânsız.
const EN_KISA_SIFRE = 12;
// Karışan harfler yok (0/O, 1/l/I), telefondan da rahat yazılsın.
const ALFABE = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const kullanici = (await sor("Kullanıcı adı: ")).trim();
if (!kullanici) cik("Kullanıcı adı boş olamaz.");

let sifre = await sor(`Şifre (en az ${EN_KISA_SIFRE} karakter; boş bırak, ben üreteyim): `, true);
if (sifre === "") {
  sifre = rastgeleSifre(EN_KISA_SIFRE);
  console.log(`\nŞifren: ${sifre}\nBunu şimdi bir yere kaydet; bir daha gösterilmeyecek.\n`);
} else {
  if (sifre.length < EN_KISA_SIFRE) cik(`Şifre en az ${EN_KISA_SIFRE} karakter olmalı.`);
  if (sifre !== (await sor("Şifre tekrar: ", true))) cik("Şifreler aynı değil.");
}

const tuz = crypto.getRandomValues(new Uint8Array(16));
const anahtar = await crypto.subtle.importKey("raw", new TextEncoder().encode(sifre), "PBKDF2", false, ["deriveBits"]);
const ozet = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: tuz, iterations: TUR }, anahtar, 256);
const oturumAnahtari = crypto.getRandomValues(new Uint8Array(32));

yukle("PANEL_KULLANICI", kullanici);
yukle("PANEL_SIFRE_HASH", `pbkdf2$${TUR}$${b64(tuz)}$${b64(ozet)}`);
yukle("OTURUM_ANAHTARI", b64(oturumAnahtari));
console.log("\nTamam: giriş bilgileri Cloudflare'de. Açık oturumlar kapandı.");

function yukle(ad, deger) {
  console.log(`\n${ad} yükleniyor...`);
  // Windows'ta npx'i bulmak için shell gerekiyor; komut tek parça, içinde dışarıdan gelen bir şey yok.
  const sonuc = spawnSync(`npx wrangler secret put ${ad}`, {
    input: deger,
    stdio: ["pipe", "inherit", "inherit"],
    shell: true,
  });
  if (sonuc.status !== 0) cik(`${ad} yüklenemedi.`);
}

// Her harf ALFABE'den eşit olasılıkla: 256'ya tam bölünmeyen fazlalığı atarak seçeriz.
function rastgeleSifre(uzunluk) {
  const sinir = 256 - (256 % ALFABE.length);
  let sonuc = "";
  while (sonuc.length < uzunluk) {
    for (const bayt of crypto.getRandomValues(new Uint8Array(uzunluk))) {
      if (bayt < sinir && sonuc.length < uzunluk) sonuc += ALFABE[bayt % ALFABE.length];
    }
  }
  return sonuc;
}

function b64(tampon) {
  return Buffer.from(tampon).toString("base64");
}

function cik(mesaj) {
  console.error(mesaj);
  process.exit(1);
}

// Terminalden bir satır okur; gizli ise yazılanı ekrana basmaz.
function sor(soru, gizli = false) {
  return new Promise((bitti) => {
    process.stdout.write(soru);
    const girdi = process.stdin;
    girdi.setRawMode?.(true);
    girdi.resume();
    girdi.setEncoding("utf8");
    let yazi = "";

    const dinle = (parca) => {
      for (const harf of parca) {
        if (harf === "\u0003") process.exit(1); // Ctrl+C
        if (harf === "\r" || harf === "\n") {
          girdi.removeListener("data", dinle);
          girdi.setRawMode?.(false);
          girdi.pause();
          process.stdout.write("\n");
          return bitti(yazi);
        }
        if (harf === "\b" || harf === "\u007f") {
          if (yazi.length > 0) {
            yazi = yazi.slice(0, -1);
            if (!gizli) process.stdout.write("\b \b");
          }
          continue;
        }
        yazi += harf;
        if (!gizli) process.stdout.write(harf);
      }
    };
    girdi.on("data", dinle);
  });
}
