' J.A.R.V.I.S. Stealth Silent Launcher
' Starts the hands-off background assistant with 0 visible terminal windows
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

batPath = scriptDir & "\start_jarvis_hands_off.bat"
WshShell.Run Chr(34) & batPath & Chr(34), 0, False
Set WshShell = Nothing
Set fso = Nothing
