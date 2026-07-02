@echo off
title RuneType Visual Kern - Track B training (~2 days)
REM ============================================================================
REM  RuneType Visual Kerning Trainer - Track B, full autonomous run (~2 days).
REM  render (real GPOS kern) -> pack -> train (long, resumable) -> validate
REM  -> bundle into the CEP extension -> install to the live panel.
REM
REM  Just DOUBLE-CLICK this file. A console opens and shows LIVE progress; the
REM  same output is also saved to the log. Safe to close + re-run: render/pack
REM  skip finished fonts and train RESUMES from the best checkpoint. The model
REM  is installed ONLY if it passes the bias gate; otherwise Track A (the live
REM  optical kerner) keeps working untouched.
REM ============================================================================
setlocal
set PY=E:\glyphset\.venv\Scripts\python.exe
set ML=C:\Users\okana\fontmaker\ml
set REPO=C:\Users\okana\fontmaker
set LOG=E:\glyphset\kernpair_run.log
set NPZ=E:\glyphset\kernpair_npz2
set PACK=E:\glyphset\kernpair_packed2
set OUT=E:\glyphset\kernpair_out2

cd /d "%ML%"
echo(
echo ============================================================
echo   RuneType Visual Kerning Trainer - Track B  (full run ~2 days)
echo   Live progress below; also saved to:  %LOG%
echo   Safe to close and re-run - it RESUMES where it left off.
echo ============================================================
echo START %date% %time%>> "%LOG%"

echo(
echo [1/5] RENDER edge profiles + real GPOS kern  (resumable; ~30 min first time)...
"%PY%" -u render_kernpair.py --fonts E:/glyphset/fonts --out "%NPZ%" --jobs 8 2>&1 | "%PY%" tee_log.py "%LOG%"

echo(
echo [2/5] PACK labels (optical kstar + real GPOS + quality gate)...
"%PY%" -u pack_kernpair.py --npz "%NPZ%" --out "%PACK%" --jobs 8 2>&1 | "%PY%" tee_log.py "%LOG%"

echo(
echo [3/5] TRAIN pair-kern model on real foundry kerning  (~2 days, resumable, best-by-val-MAE)
echo       progress prints every 50 batches:  [ep x/y z%%] loss .. smp/s .. overall %% .. ETA
"%PY%" -u train_kernpair.py --packed "%PACK%" --out "%OUT%" --epochs 700 --steps 4000 --batch 256 --workers 8 --max-hours 44 2>&1 | "%PY%" tee_log.py "%LOG%"

echo(
echo [4/5] VALIDATE on held-out fonts + bundle if it passes the bias gate...
"%PY%" -u validate_and_bundle.py --packed "%PACK%" --model "%OUT%" --dest "%REPO%\cep\js\lib\model" --log "%LOG%"
if errorlevel 1 goto failed

echo(
echo [5/5] PASS - sync + install to the live CEP extension...
cd /d "%REPO%"
call npm run cep:install
echo DONE: model bundled + installed, button is now AI-seeded.>> "%LOG%"
echo(
echo ============================================================
echo   DONE - Visual Kern is now AI-seeded. Reopen the panel in Illustrator.
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
