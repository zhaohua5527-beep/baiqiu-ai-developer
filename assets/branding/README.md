# Baiqiu Official Icon

This directory is the single source of truth for Baiqiu branding.

## Source

- Original user-approved image: `baiqiu-official-source.png`
- Original SHA-256: `13200C424E5B038211F8E5C7CC0C5C6B221C2F5FBE049B4392E0E6A1E1157F07`
- Square production master: `baiqiu-official-master.png`

Do not restore or publish any previous Baiqiu or Heiqiu icon.

## Required Targets

- Windows app, installer, shortcuts: `assets/icon.ico`
- Renderer and tray: `renderer/assets/baiqiu-icon.*`, `renderer-v2/assets/baiqiu-icon.*`
- Windows shortcut cache-safe icon: `renderer/assets/baiqiu-ai-rounded-20260723.ico`
- Website favicon and PWA assets: `assets/branding/web/`

Every client, website, GitHub release, update package, installer, desktop shortcut,
Start menu shortcut, window icon, and tray icon must use this icon family.

The customer-facing Windows shortcut name is exactly `白球 ai`.

The website assets are deployment inputs. Copy them into the website public root and
reference `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, and `icon-512.png`.
