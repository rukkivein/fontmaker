; RuneType Glyphmaker — Illustrator CEP extension installer (per-user, no admin).
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
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=RuneType_Glyphmaker_Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}

[Files]
Source: "..\cep\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

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
WelcomeLabel2=This will install the {#AppName} panel into Adobe Illustrator.%n%nAfter installing, open Illustrator and choose Window ▸ Extensions ▸ {#AppName}.

[Run]
Filename: "{app}\index.html"; Description: "Open the panel folder"; Flags: shellexec postinstall skipifsilent unchecked
