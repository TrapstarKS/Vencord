#!/usr/bin/env bash
# Instalador da versao do Vencord do fork TrapstarKS/Vencord (macOS)
# - Nao precisa de Node nem git clone.
# - Baixa os arquivos JA PRONTOS do release "devbuild", injeta no Discord,
#   e a partir dai o Vencord se auto-atualiza sozinho do fork.
#
# Uso recomendado (cola no Terminal):
#   curl -fsSL https://raw.githubusercontent.com/TrapstarKS/Vencord/main/scripts/installFork.sh | bash

set -eo pipefail

REPO="TrapstarKS/Vencord"
TAG="devbuild"
FILES=(patcher.js preload.js renderer.js renderer.css \
       vencordDesktopMain.js vencordDesktopPreload.js \
       vencordDesktopRenderer.js vencordDesktopRenderer.css)

DATA_DIR="$HOME/Library/Application Support/VencordFork"
DIST_DIR="$DATA_DIR/dist"
TMP_DIR="$(mktemp -d)"
INSTALLER_ZIP="$TMP_DIR/VencordInstaller.MacOS.zip"
INSTALLER_BIN="$TMP_DIR/VencordInstaller.app/Contents/MacOS/VencordInstaller"
LOCK_DIR="${TMPDIR:-/tmp}/vencord-fork-installer.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Ja existe outra instalacao do Vencord em andamento. Feche-a e tente novamente."
    exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

echo "======================================================"
echo "  Instalando Vencord (fork $REPO)"
echo "======================================================"
echo

mkdir -p "$DIST_DIR"

echo "Baixando a versao mais recente do fork..."
for f in "${FILES[@]}"; do
    if ! curl -fsSL "https://github.com/$REPO/releases/download/$TAG/$f" -o "$DIST_DIR/$f"; then
        echo "ERRO: nao consegui baixar '$f'."
        echo "O release '$TAG' ja existe no fork? (a Action 'Publish DevBuild' precisa ter rodado)"
        exit 1
    fi
done

echo "Baixando o injetor..."
curl -fsSL "https://github.com/Vencord/Installer/releases/latest/download/VencordInstaller.MacOS.zip" -o "$INSTALLER_ZIP"
unzip -oq "$INSTALLER_ZIP" -d "$TMP_DIR"
chmod +x "$INSTALLER_BIN"
xattr -dr com.apple.quarantine "$TMP_DIR" 2>/dev/null || true

# descobrir quais Discords estao instalados
NAMES=()
if [ -d "/Applications/Discord.app" ];        then NAMES+=("Discord"); fi
if [ -d "/Applications/Discord PTB.app" ];    then NAMES+=("Discord PTB"); fi
if [ -d "/Applications/Discord Canary.app" ]; then NAMES+=("Discord Canary"); fi
if [ ${#NAMES[@]} -eq 0 ]; then
    echo "Nenhum Discord encontrado em /Applications."
    exit 1
fi
echo "Discord encontrado: ${NAMES[*]}"

echo "Fechando o Discord..."
pkill -9 -i discord 2>/dev/null || true
sleep 2

export VENCORD_USER_DATA_DIR="$DATA_DIR"
export VENCORD_DEV_INSTALL="1"
echo "Abrindo o instalador oficial uma vez..."
echo "Selecione nele a instalacao/branch que deseja modificar."
"$INSTALLER_BIN" || echo "  (aviso: o instalador terminou com erro)"

echo "Reabrindo o Discord..."
for n in "${NAMES[@]}"; do
    open -a "$n" 2>/dev/null || true
done

echo
echo "======================================================"
echo "  Pronto! Vencord (fork) instalado."
echo "  Ele se auto-atualiza sozinho a partir de agora."
echo "  O instalador foi aberto uma unica vez para evitar janelas duplicadas."
echo "  Dica: Settings > Updater > 'Automatically update'."
echo "======================================================"
