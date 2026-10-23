// Testler: `npm test`. Worker bilgisayarda, Cloudflare'in yerel kopyasında (Miniflare) çalışır.
// Canlı Worker'a, canlı KV'ye ve gerçek Instagram'a dokunulmaz: KV hafızada, Instagram sahte (test/yardimci.js),
// gizli bilgiler de aşağıdaki test değerleri (gerçek token ve şifre teste hiç verilmez).

import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { pbkdf2Sync } from "node:crypto";

// Yalnız testte geçerli giriş bilgisi; test/yardimci.js aynı şifreyle giriş yapar.
export const TEST_SIFRESI = "test-sifresi-1234";
const tuz = Buffer.from("test-tuzu-16bayt");
const ozet = pbkdf2Sync(TEST_SIFRESI, tuz, 100_000, 32, "sha256");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          IG_TOKEN: "sahte-token",
          PANEL_KULLANICI: "test",
          PANEL_SIFRE_HASH: `pbkdf2$100000$${tuz.toString("base64")}$${ozet.toString("base64")}`,
          OTURUM_ANAHTARI: "test-oturum-anahtari",
          TEST_SIFRESI,
        },
      },
    }),
  ],
});
