param([string]$Python = "py")
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Run this script on Windows." }
Push-Location $PSScriptRoot
$buildDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mttl-build-" + [guid]::NewGuid())
try {
    & $Python -c "import tkinter, nuitka"
    if ($LASTEXITCODE -ne 0) { throw "Install Python with Tkinter and requirements-build.txt first." }
    New-Item -ItemType Directory -Path $buildDir | Out-Null
    foreach ($app in @("ota", "setup_wifi")) {
        $adminOptions = @()
        if ($app -eq "ota") { $adminOptions = @("--windows-uac-admin") }
        & $Python -m nuitka `
            @adminOptions `
            --onefile --enable-plugin=tk-inter `
            --windows-console-mode=disable `
            "--windows-icon-from-ico=icons/$app.ico" `
            "--include-data-files=icons/$app.png=icons/$app.png" `
            "--output-dir=$buildDir" `
            "--report=$buildDir/$app-report.xml" `
            "${app}_gui.py"
        if ($LASTEXITCODE -ne 0) { throw "Build failed: $app" }
    }
    foreach ($app in @("ota", "setup_wifi")) {
        if (!(Test-Path -LiteralPath "$buildDir/${app}_gui.exe" -PathType Leaf)) {
            throw "Missing executable: $app"
        }
    }
    foreach ($app in @("ota", "setup_wifi")) {
        Move-Item -LiteralPath "$buildDir/${app}_gui.exe" -Destination "../${app}_gui_windows.exe" -Force
    }
} finally {
    if (Test-Path -LiteralPath $buildDir) { Remove-Item -LiteralPath $buildDir -Recurse -Force }
    Pop-Location
}
