# Instalador da versao do Vencord do fork TrapstarKS/Vencord
# - Nao precisa de Node, nem git clone, nem admin.
# - Baixa os arquivos JA PRONTOS do release "devbuild", injeta no Discord,
#   e a partir dai o Vencord se auto-atualiza sozinho do fork.
#
# Rodado normalmente via installFork.bat (irm ... | iex).

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$Repo         = "TrapstarKS/Vencord"
$ReleaseTag   = "devbuild"
$Files        = @(
    "patcher.js", "preload.js", "renderer.js", "renderer.css",
    "vencordDesktopMain.js", "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"
)
$DataDir      = Join-Path $env:LOCALAPPDATA "VencordFork"
$DistDir      = Join-Path $DataDir "dist"
$TmpDir       = Join-Path $env:TEMP "VencordForkSetup"
$InstallerUrl = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
$InstallerBin = Join-Path $TmpDir "VencordInstallerCli.exe"

function Say($msg, $color = "Cyan") { Write-Host $msg -ForegroundColor $color }
function Fail($msg) {
    Write-Host "`nERRO: $msg" -ForegroundColor Red
    Write-Host "Tira um print e manda pro TrapstarKS." -ForegroundColor Yellow
    exit 1
}

try {
    Say "======================================================" "Green"
    Say "  Instalando Vencord (fork $Repo)" "Green"
    Say "======================================================" "Green"
    Write-Host ""

    # 1) pastas
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    New-Item -ItemType Directory -Force -Path $TmpDir  | Out-Null

    # 2) baixar os arquivos prontos do release "devbuild"
    Say "Baixando a versao mais recente do fork..."
    foreach ($f in $Files) {
        $url = "https://github.com/$Repo/releases/download/$ReleaseTag/$f"
        try {
            Invoke-WebRequest -Uri $url -OutFile (Join-Path $DistDir $f)
        } catch {
            Fail "nao consegui baixar '$f'.`n      O release '$ReleaseTag' ja existe no fork? (a Action 'Publish DevBuild' precisa ter concluido pelo menos 1 vez)"
        }
    }

    # 3) baixar o Installer oficial do Vencord (so o patcher, nao precisa de Node)
    Say "Baixando o injetor..."
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerBin

    # 4) descobrir quais Discords estao instalados
    $allBranches = @(
        [pscustomobject]@{ Name = "Discord";       Exe = "Discord.exe";       Branch = "stable" },
        [pscustomobject]@{ Name = "DiscordPTB";    Exe = "DiscordPTB.exe";    Branch = "ptb" },
        [pscustomobject]@{ Name = "DiscordCanary"; Exe = "DiscordCanary.exe"; Branch = "canary" }
    )
    $found = $allBranches | Where-Object { Test-Path (Join-Path $env:LOCALAPPDATA $_.Name) }
    if (-not $found) { Fail "nenhum Discord encontrado nesse PC." }
    Say ("Discord encontrado: " + (($found | ForEach-Object { $_.Name }) -join ", "))

    # 5) fechar o Discord (precisa estar fechado pra injetar)
    Say "Fechando o Discord..."
    Get-Process -Name "Discord*" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3

    # 6) injetar em cada branch, apontando pros arquivos do fork
    $env:VENCORD_USER_DATA_DIR = $DataDir
    $env:VENCORD_DEV_INSTALL   = "1"
    foreach ($b in $found) {
        Say ("Injetando no " + $b.Name + "...")
        & $InstallerBin -install -branch $b.Branch
        if ($LASTEXITCODE -ne 0) { Say ("  (aviso: codigo " + $LASTEXITCODE + " no " + $b.Name + ")") "Yellow" }
    }

    # 7) reabrir o Discord
    Say "Reabrindo o Discord..."
    foreach ($b in $found) {
        $upd = Join-Path (Join-Path $env:LOCALAPPDATA $b.Name) "Update.exe"
        if (Test-Path $upd) { Start-Process $upd -ArgumentList "--processStart", $b.Exe }
    }

    Write-Host ""
    Say "======================================================" "Green"
    Say "  Pronto! Vencord (fork) instalado." "Green"
    Say "  Ele se auto-atualiza sozinho a partir de agora." "Green"
    Say "  Dica: Settings > Updater > 'Automatically update'." "Green"
    Say "======================================================" "Green"
}
catch {
    Fail $_.Exception.Message
}
