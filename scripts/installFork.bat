@echo off
title Instalar Vencord (fork TrapstarKS)
echo.
echo   ============================================
echo     Instalando a versao do Vencord do fork
echo     TrapstarKS/Vencord
echo   ============================================
echo.
echo   Nao feche esta janela. Se o Discord estiver
echo   aberto, ele vai fechar e reabrir sozinho.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/TrapstarKS/Vencord/main/scripts/installFork.ps1 | iex"
echo.
pause
