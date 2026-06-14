; RuneType Glyphmaker — Illustrator CEP extension installer (per-user, no admin).
; Glassmorphic dark reskin: branded wizard image, brush wordmark, red BRST stamp.
; Installs the panel into the user's CEP extensions folder and enables unsigned
; CEP extensions (PlayerDebugMode) for the relevant CSXS runtimes.

#define AppName "RuneType Glyphmaker"
#define AppVer "1.00"
#define ExtId "com.fontmaker.illustrator"

[Setup]
AppId={{B9F1A7E2-4C3D-4E8A-9F21-RUNETYPE0001}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=BRST STUDIO
DefaultDirName={userappdata}\Adobe\CEP\extensions\{#ExtId}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=RuneType_Glyphmaker_Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
WizardImageStretch=yes
WizardImageFile=assets\wizard-large.bmp
WizardSmallImageFile=assets\wizard-small.bmp
SetupIconFile=assets\setup.ico
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\setup-uninstall.ico

[Files]
Source: "..\cep\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "assets\setup.ico"; DestDir: "{app}"; DestName: "setup-uninstall.ico"; Flags: ignoreversion
; runtime-only graphics (extracted to {tmp}, not installed)
Source: "assets\wordmark.bmp"; Flags: dontcopy

[Registry]
; allow unsigned CEP extensions to load (per-user). Cover CSXS 6..12.
Root: HKCU; Subkey: "Software\Adobe\CSXS.6";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.7";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.8";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist uninsdeletevalue

[Messages]
WelcomeLabel2=Turn your Illustrator shapes into real fonts.%n%nThis installs the {#AppName} panel — no admin required. After installing, open Illustrator and choose Window ▸ Extensions ▸ {#AppName}.
FinishedHeadingLabel=RuneType is ready.
FinishedLabelNoIcons=Open Adobe Illustrator and choose Window ▸ Extensions ▸ {#AppName} to start designing.

[Run]
Filename: "{app}"; Description: "Open the installed panel folder"; Flags: shellexec postinstall unchecked

[Code]
const
  cDark   = $00221D1B;   { content / form bg  #1B1D22 }
  cPanel  = $001B1715;   { slightly darker panel  #15171B }
  cInk    = $00DADBDC;   { primary text  #DCDBDA }
  cMuted  = $00969696;   { secondary text }
  cBarBlue= $00F39640;   { progress fill  #4096F3 (TColor BGR) }
  cTrack  = $00322E2B;   { progress track #2B2E32 (visible on dark) }

var
  WordmarkImg: TBitmapImage;
  BarTrack, BarFill: TPanel;

procedure Recolor(Parent: TWinControl);
var
  i: Integer;
  C: TControl;
begin
  for i := 0 to Parent.ControlCount - 1 do
  begin
    C := Parent.Controls[i];
    if C is TNewStaticText then
      TNewStaticText(C).Font.Color := cInk
    else if C is TLabel then
    begin
      TLabel(C).Font.Color := cInk;
      TLabel(C).Transparent := True;
    end
    else if C is TNewCheckBox then
      TNewCheckBox(C).Font.Color := cInk
    else if C is TRadioButton then
      TRadioButton(C).Font.Color := cInk
    else if C is TNewMemo then
    begin
      TNewMemo(C).Color := cPanel;
      TNewMemo(C).Font.Color := cInk;
    end
    else if C is TNewEdit then
    begin
      TNewEdit(C).Color := cPanel;
      TNewEdit(C).Font.Color := cInk;
    end
    else if C is TNewNotebookPage then
      TNewNotebookPage(C).Color := cDark
    else if C is TPanel then
      TPanel(C).Color := cDark;

    if C is TWinControl then
      Recolor(TWinControl(C));
  end;
end;

procedure InitializeWizard();
var
  cx, cw: Integer;
begin
  { overall dark theme }
  WizardForm.Color := cDark;
  WizardForm.MainPanel.Color := cDark;
  WizardForm.InnerPage.Color := cDark;
  WizardForm.WelcomePage.Color := cDark;
  WizardForm.Bevel.Visible := False;
  WizardForm.PageNameLabel.Font.Color := cInk;
  WizardForm.PageDescriptionLabel.Font.Color := cMuted;
  WizardForm.BeveledLabel.Font.Color := cMuted;
  Recolor(WizardForm);

  { brush wordmark on the welcome page, to the right of the image band }
  ExtractTemporaryFile('wordmark.bmp');
  WordmarkImg := TBitmapImage.Create(WizardForm);
  WordmarkImg.Parent := WizardForm.WelcomePage;
  WordmarkImg.Bitmap.LoadFromFile(ExpandConstant('{tmp}\wordmark.bmp'));
  WordmarkImg.Stretch := True;

  cx := WizardForm.WizardBitmapImage.Left + WizardForm.WizardBitmapImage.Width + ScaleX(30);
  cw := WizardForm.WelcomePage.ClientWidth - cx - ScaleX(30);
  WordmarkImg.Left := cx;
  WordmarkImg.Top := ScaleY(44);
  WordmarkImg.Width := cw;
  WordmarkImg.Height := Round(cw / 1.458);

  WizardForm.WelcomeLabel1.Visible := False;
  WizardForm.WelcomeLabel2.Left := cx;
  WizardForm.WelcomeLabel2.Width := cw;
  WizardForm.WelcomeLabel2.Top := WordmarkImg.Top + WordmarkImg.Height + ScaleY(26);
  WizardForm.WelcomeLabel2.Font.Color := cInk;

  { custom flat blue progress bar replacing the native green one }
  WizardForm.ProgressGauge.Visible := False;
  BarTrack := TPanel.Create(WizardForm);
  BarTrack.Parent := WizardForm.ProgressGauge.Parent;
  BarTrack.BevelOuter := bvNone;
  BarTrack.BevelInner := bvNone;
  BarTrack.ParentBackground := False;
  BarTrack.Color := cTrack;
  BarTrack.SetBounds(WizardForm.ProgressGauge.Left, WizardForm.ProgressGauge.Top,
                     WizardForm.ProgressGauge.Width, WizardForm.ProgressGauge.Height);
  BarFill := TPanel.Create(WizardForm);
  BarFill.Parent := BarTrack;
  BarFill.BevelOuter := bvNone;
  BarFill.BevelInner := bvNone;
  BarFill.ParentBackground := False;
  BarFill.Color := cBarBlue;
  BarFill.SetBounds(0, 0, BarTrack.Width, BarTrack.Height);
  BarTrack.BringToFront;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpInstalling) and (BarTrack <> nil) then
  begin
    BarTrack.SetBounds(WizardForm.ProgressGauge.Left, WizardForm.ProgressGauge.Top,
                       WizardForm.ProgressGauge.Width, WizardForm.ProgressGauge.Height);
    { Inno exposes no per-file progress event; the per-user copy is ~instant,
      so show a full blue bar while the install page is briefly visible. }
    BarFill.SetBounds(0, 0, BarTrack.Width, BarTrack.Height);
    BarTrack.BringToFront;
    BarTrack.Refresh;
  end;
end;
