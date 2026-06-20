@echo off
title RuneType - Tam Otomatik Egitim
echo ================================================================
echo   RuneType Glyph Tanima Modeli - TAM OTOMATIK
echo.
echo   Bu pencere her seyi tek basina yapar:
echo     1) Google Fonts indirir (zaten varsa atlar)
echo     2) TUM fontlari isler  (bilgisayardaki LOKAL fontlar dahil)
echo     3) Veri setini paketler
echo     4) Modeli GPU ile egitir
echo     5) Hazir modeli fontmaker plugin klasorune kopyalar
echo.
echo   - Cokerse: bu dosyaya tekrar cift tikla; kaldigi yerden devam eder.
echo   - DONE yazana kadar bu pencereyi ACIK birak (PC uyumaz).
echo   - Canli takip istersen: RuneType_Watch.bat
echo ================================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\okana\fontmaker\ml\run_all.ps1"
echo.
echo ================================================================
echo   BITTI. Model hazir:
echo     E:\glyphset\out\glyph_int8.onnx
echo   ve plugin klasorune kopyalandi (cep\js\lib\model).
echo   Simdi Claude'a "model hazir" de, panele baglasin.
echo ================================================================
pause
