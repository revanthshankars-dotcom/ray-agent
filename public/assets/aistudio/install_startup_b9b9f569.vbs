Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = baseDir & "\start_jarvis_stealth.vbs"
If Not fso.FileExists(launcherPath) Then
    WScript.Echo "[!] Startup launcher not found: " & launcherPath
    WScript.Quit 1
End If

startupDir = WshShell.SpecialFolders("Startup")
shortcutPath = startupDir & "\JARVIS_Assistant.lnk"

Set shortcut = WshShell.CreateShortcut(shortcutPath)
shortcut.TargetPath = WshShell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
shortcut.Arguments = """" & launcherPath & """"
shortcut.WorkingDirectory = baseDir
shortcut.Description = "J.A.R.V.I.S. 2.0 Stealth Background Assistant"
shortcut.Save

WScript.Echo "[✓] Auto-startup shortcut successfully created at: " & shortcutPath
