#!/bin/bash
# Duplo-clique no Mac. Baixa e roda o instalador do fork.
# Se o Gatekeeper reclamar: clique com o botao direito > Abrir (so na 1a vez).
# Se disser que nao pode executar, rode no Terminal:
#   curl -fsSL https://raw.githubusercontent.com/TrapstarKS/Vencord/main/scripts/installFork.sh | bash
clear
curl -fsSL "https://raw.githubusercontent.com/TrapstarKS/Vencord/main/scripts/installFork.sh" | bash
echo
read -n 1 -s -r -p "Aperte qualquer tecla pra fechar..."
echo
