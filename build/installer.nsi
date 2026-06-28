; NSIS installer for Smart Gallery Timeline.
; Packages the electron-builder win-unpacked output into a per-user installer
; (no admin required), bypassing electron-builder's macOS signing tooling which
; cannot extract on Windows without symlink privilege.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME    "Smart Gallery Timeline"
!define COMPANY    "Smart Gallery"
!define EXE        "Smart Gallery Timeline.exe"
; VERSION is normally passed in by scripts/build-installer.js from package.json
; (makensis -DVERSION=<x>). The fallback keeps a bare `makensis build\installer.nsi`
; working for ad-hoc builds.
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
; ROOT is the repo root. This script lives in <root>\build, so by default we
; derive it from the script's own directory (${__FILEDIR__}). Override from any
; checkout location with:  makensis -DROOT=<path-to-repo> build\installer.nsi
!ifndef ROOT
  !define ROOT "${__FILEDIR__}\.."
!endif
!define SOURCE     "${ROOT}\dist-installer\win-unpacked"
!define UNINSTKEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
OutFile "${ROOT}\dist-installer\Smart Gallery Timeline Setup ${VERSION}.exe"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
ShowInstDetails show
ShowUnInstDetails show
BrandingText "${APPNAME} ${VERSION}"

!define MUI_ABORTWARNING
!define MUI_ICON   "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APPNAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${SOURCE}\*"

  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}"
  CreateShortCut "$DESKTOP\${APPNAME}.lnk"   "$INSTDIR\${EXE}"

  WriteUninstaller "$INSTDIR\Uninstall ${APPNAME}.exe"
  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\Uninstall ${APPNAME}.exe$\""
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\${APPNAME}"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
