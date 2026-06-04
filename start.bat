@echo off
:: Penguin — thin wrapper. All real work happens in launcher.vbs / launcher.ps1.
:: Kept so existing muscle memory ("double-click start.bat") still works; brand-new
:: users open the Desktop / Start Menu "Penguin" shortcut which points straight
:: at launcher.vbs (no cmd flash).
:: v2.1 migration: drop pre-renumber template files an overlay update leaves behind
:: (templates were renumbered 01-11 by display order; Expand-Archive cannot delete).
for %%T in (01-editorial-dark 02-minimal-light 03-bold-pitch 04-corporate-navy 05-saas-gradient 06-infographic-fresh 07-soft-blue 08-spectrum-steps 09-aurora-flow 10-nova 11-pulse) do if exist "%~dp0templates\%%T.html" del /q "%~dp0templates\%%T.html" >nul 2>&1
wscript "%~dp0launcher.vbs"
