# İkinci AI için sistem tanıtım prompt'u (Türkçe)

> Bunu ikinci yapay zekaya **olduğu gibi yapıştır**. Sadece sistemi tanıtır; görevi sen
> (kullanıcı) vereceksin.

---

Aşağıda üzerinde çalışacağın yazılımın nasıl çalıştığını ve hangi sisteme ait olduğunu
anlatıyorum. **Sana henüz bir görev vermiyorum** — görevi sana kullanıcı verecek. Senden
istediğim tek şey: bu sistemi anlayıp anlamadığını kısaca teyit etmen. Anladıysan kullanıcı
devam edecek.

## Yazılım: RuneType™ Glyphmaker (BRST STUDIO)

Bir **Adobe Illustrator CEP eklentisi** (panel). Illustrator'da **çizilen vektör şekillerini
gerçek fonta** çevirir (OTF; TTF ve Variable altyapısı mevcut ama tek-dosya variable export
henüz tamamlanmadı — aşağıya bak). UXP değil **CEP**'tir; panel **Node** çalıştırır
(`require`, `fs`, `Buffer` yerel).

## Lokal yer ve çalıştırma
- Kaynak: `C:\Users\okana\fontmaker` (git branch: `claude/inspiring-bardeen-fqkF4`).
- Kurulu eklenti: `%APPDATA%\Adobe\CEP\extensions\com.fontmaker.illustrator`.
- Kur/senkron/test (repo kökünde): `npm run cep:install` · `npm run cep:sync` · `npm test`.
- Illustrator → Window → Extensions → "RuneType Glyphmaker". CEP debug portu 8088.
- **Tam ayrıntı `C:\Users\okana\fontmaker\HANDOFF.md` dosyasında** — varsa onu da oku.

## Mimari (önemli dosyalar)
- `shared/` — taşınabilir saf JS (Node + CEP'te aynı). `sync-cep.js` bunları `cep/js`'e kopyalar
  (her değişiklikten sonra `npm run cep:install`; `test/cepsync.test.js` senkronu korur):
  - `glyphset.js` = **veri modeli** (createProject, addMaster, setGlyphContours, metrics, UPM)
  - `ilbridge.js` = Illustrator path ↔ font kontur köprüsü (Y-aşağı → Y-yukarı çevrim)
  - `refspace.js` = aralık ("X value") matematiği · `optimizer.js` = spacing/kerning
  - `varCompat.js` = **variable uyumu** (master kontur uyumu + nokta hizalama) · `charsets.js`
- `core/` — `fontEngine.js` (OTF/CFF, opentype.js, GSUB, winding) · `ttfWriter.js` (TTF/glyf)
- `cep/` — `index.html` (UI), `js/main.js` (~2600 satır panel mantığı), `jsx/fontmaker.jsx`
  (ExtendScript — Illustrator host köprüsü), `css/styles.css`.
- Köprü: `main.js` → `CSInterface.evalScript('fmXxx(jsonArg)')`; `.jsx` JSON string döndürür.

## Veri modeli (en kritik kısım)
Font birimi, **UPM 1000**, **Y yukarı** (baseline = 0, descender negatif):
```js
project = {
  unitsPerEm: 1000,
  metrics: { ascender:800, capHeight:716, xHeight:519, baseline:0, descender:-200 },
  masters: [ {id:'m0', name:'Regular', type:'Regular'}, … ],   // VARIABLE = birden çok master
  glyphs: [ {
    name, char, unicode, alphabet, advanceWidth, lsbLineX,
    layers: { 'm0': { contours:[ {closed, points:[ {x,y,type,handleIn,handleOut} ]} ] }, … }
  }, … ]
}
```
Illustrator artboard'taki çizim → font birimine `ilbridge.contoursFromArtboard(paths, rect,
scale, descender)` ile eşlenir. Ölçek sabitleri: `FM_SCALE=0.25` (per-glyph çizim),
`FM_TPL_SCALE=0.1` (template sayfası).

## Variable font durumu (bilmen gereken sınır)
- Master'lar veri olarak **var**; `varCompat.js` master'lar arası uyumu kontrol edip noktaları
  **hizalar** (hazır).
- **Eksik:** tek dosyalık **fvar/gvar** variable font ÜRETİMİ yok. Şu an "Variable" export'u
  her master'ı ayrı dosya çıkarır + bir uyum raporu yazar. Gerçek variable için dokunulacak
  yerler: `core/fontEngine.js` (fvar/gvar), `core/ttfWriter.js` (gvar binary),
  `cep/js/main.js` export akışı (~1975. satır), `shared/features.js` (`exportVariable` kapısı).

## Sağlam kurallar
- **Font boyutu asla otomatik değişmez** — yalnızca aralık/kerning/yatay konum.
- ExtendScript (`cep/jsx`) tarayıcıda test edilemez; saf JS bitleri Node'da (`test/`) test edilir,
  gerisi Illustrator'da canlı doğrulanır.
- `cep/`, `shared/`, `core/` düzenledikten sonra **mutlaka `npm run cep:install`**.

---

**Lütfen bu sistemi/akışı anladığını kısaca teyit et** (özellikle: veri modeli, master/layer
yapısı, variable font'un mevcut durumu ve hangi dosyaların değişmesi gerektiği). Anladıysan
kullanıcı sana asıl görevini verecek.
