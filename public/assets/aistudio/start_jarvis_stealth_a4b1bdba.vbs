Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Launch Tray Mission Control and Background Voice Daemon completely silently (window style 0 = hidden)
WshShell.Run Chr(34) & scriptDir & "\.venv\Scripts\pythonw.exe" & Chr(34) & " tray.py", 0, False
WshShell.Run Chr(34) & scriptDir & "\.venv\Scripts\pythonw.exe" & Chr(34) & " main.py --daemon", 0, False
