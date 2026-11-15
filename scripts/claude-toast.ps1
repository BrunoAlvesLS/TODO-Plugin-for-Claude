<#
.SYNOPSIS
  Shows one Windows toast headed "Claude" (the desktop app's app id).
  The text comes from the TODO_TOAST_TITLE and TODO_TOAST_BODY environment variables
  and is XML-escaped here, so it is never part of the script or the XML markup.
  Needs Windows PowerShell 5.1 (powershell.exe) for the WinRT types.
#>
$ErrorActionPreference = 'Stop'
$ClaudeAppId = 'Claude_pzs8sxrjxfjjc!Claude'

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$t = [System.Security.SecurityElement]::Escape([string]$env:TODO_TOAST_TITLE)
$b = [System.Security.SecurityElement]::Escape([string]$env:TODO_TOAST_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($ClaudeAppId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
