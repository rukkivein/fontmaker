@echo off
title RuneType Visual Kern - PARAGRAPH model (Track B-2, ~2 days)
REM ============================================================================
REM  RuneType Visual Kerning Trainer - PARAGRAPH (running-strip) model, ~2 days.
REM  Renders the all-combinations paragraph per font as a real strip and learns to
REM  even each gap WITHIN its neighbor rhythm (the user's "learn a paragraph" vision).
REM  render (real GPOS) -> pack -> train_paragraph (long, resumable) -> validate
REM  (bias + context-stability + OOD-safety gates) -> bundle + install if it passes.
REM
REM  Live %% progress on screen + saved to the log. Safe to close + re-run: render/pack
REM  skip finished fonts, train RESUMES from best.pt. Installs ONLY if the gates pass;
REM  otherwise Track A (the live optical kerner) keeps working untouched.
REM ============================================================================
setlocal
set PY=E:\glyphset\.venv\Scripts\python.exe
set ML=C:\Users\okana\fontmaker\ml
set REPO=C:\Users\okana\fontmaker
set LOG=E:\glyphset\paragraph_run.log
set NPZ=E:\glyphset\kernpair_npz2
set PACK=E:\glyphset\kernpair_packed2
set OUT=E:\glyphset\paragraph_out

cd /d "%ML%"
echo(
echo ============================================================
echo   RuneType PARAGRAPH Kern Trainer  (full run ~2 days)
echo   Live %%-progress below; also saved to:  %LOG%
echo   Safe to close and re-run - it RESUMES where it left off.
echo ============================================================
echo START %date% %time%>> "%LOG%"

echo(
echo [1/5] RENDER edge profiles + real GPOS kern  (resumable; ~3307/15851 already done)...
"%PY%" -u render_kernpair.py --fonts E:/glyphset/fonts --out "%NPZ%" --jobs 8 2>&1 | "%PY%" tee_log.py "%LOG%"

echo(
echo [2/5] PACK labels (kstar + real GPOS + qscore) -> kernpair_packed2 ...
"%PY%" -u pack_kernpair.py --npz "%NPZ%" --out "%PACK%" --jobs 8 2>&1 | "%PY%" tee_log.py "%LOG%"

echo(
echo [3/5] TRAIN paragraph model  (~40h, RESUMES from best.pt, cosine warm-restarts, best-by-val-MAE)
echo       %%-progress every 50 batches:  [ep x/y zz%%] loss .. smp/s .. overall XX.X%% .. ETA
"%PY%" -u train_paragraph.py --packed "%PACK%" --out "%OUT%" --epochs 510 --steps 4000 --batch 256 --workers 8 --max-hours 40 2>&1 | "%PY%" tee_log.py "%LOG%"

echo(
echo [4/5] VALIDATE paragraph model (bias + context-stability + OOD-safety gates)...
"%PY%" -u validate_and_bundle.py --arch paragraph --packed "%PACK%" --model "%OUT%" ^
  --ood "C:/Users/okana/Desktop/font/!readytogo/Unbound - BLACKMAW" ^
  --ood "C:/Users/okana/Desktop/Aktif Isler/New Silkroad" ^
  --dest "%REPO%\cep\js\lib\model" --log "%LOG%"
if errorlevel 1 goto failed

echo(
echo [5/5] PASS - sync + install to the live CEP extension...
cd /d "%REPO%"
call npm run cep:install
echo DONE: paragraph model bundled + installed, button is now AI (paragraph) seeded.>> "%LOG%"
echo(
echo ============================================================
echo   DONE - Paragraph kern model is live. Reopen the panel in Illustrator.
echo ============================================================
goto end

:failed
echo(
echo ============================================================
echo   VALIDATION DID NOT PASS - model NOT installed.
echo   Track A (the live optical kerner) keeps working as-is.
echo   See the gate numbers in:  %LOG%
echo ============================================================

:end
echo END %date% %time%>> "%LOG%"
echo(
pause
endlocal
