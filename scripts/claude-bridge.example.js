'use strict';

/**
 * claude-bridge'i kütüphane olarak nasıl kullanırsınız — küçük örnek.
 * Çalıştırmak için:  node scripts/claude-bridge.example.js
 */

const { ask, askStream, askJson, isInstalled } = require('./claude-bridge');

(async () => {
  // 1) Önce kurulu mu diye bak
  const sürüm = await isInstalled();
  if (!sürüm) {
    console.error('Claude Code kurulu değil. Önce kurup giriş yapın.');
    process.exit(1);
  }
  console.log('Claude Code sürümü:', sürüm, '\n');

  // 2) Basit soru-cevap
  const cevap = await ask('Bir fontmaker projesi için yaratıcı 3 font ismi öner. Sadece liste ver.');
  console.log('--- ask() ---\n' + cevap + '\n');

  // 3) Canlı (stream) çıktı
  process.stdout.write('--- askStream() ---\n');
  await askStream('Tek cümlede tipografi nedir?', (parça) => process.stdout.write(parça));
  process.stdout.write('\n\n');

  // 4) JSON çıktı (üst veriyle birlikte)
  const json = await askJson('2 + 2 kaç? Sadece sayıyı söyle.');
  console.log('--- askJson() ---');
  console.log('result:', json.result);
})().catch((e) => {
  console.error('Hata:', e.message);
  process.exit(1);
});
