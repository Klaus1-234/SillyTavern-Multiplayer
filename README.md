# SILLYTAVERN MULTIPLAYER

This is a hobby project. Do not expect high quality, support, frequent updates or active maintenance. I do not really know my way around GitHub either (pull requests, maintainers, actions, wiki, security reports, code quality standards, etc.), so do not expect any of that here.

## Description

SillyTavern is an Open Source project mainly used for solo roleplay with AI characters. This extension provides a new experience: group AI roleplay with your friends, connecting your SillyTavern instances with each other to create a fluid and fun roleplay experience with friends and AI.

## Features

1. Create a password-protected room from the extension.
2. Join from another instance by pasting the URL and the room code.
3. The client only installs the extension by dragging the folder into their extensions folder.
4. Room server as a SillyTavern plugin (host only).
5. Proxy to expose the host through a private tunnel.
6. Disconnect at any moment from the extension itself.

## Stack

- **JavaScript (ESM)**: the extension, `multiplayer.mjs` (server plugin) and `mp-proxy.mjs` (proxy).
- **HTML and CSS**: extension interface.
- **Node.js**: running the server plugin and the proxy.
- **SillyTavern**: the platform it runs on — extension system, plugins and `config.yaml`.
- **HTTP tunnel**: any tunnel service to expose the host.

## How to run

Two roles: host and client. Requirements: Node.js and a SillyTavern installation.

1. **Host** (once): follow the `HOST (once)` and `PLAYING` steps in the guide below.
2. **Client**: follow the `CLIENT` steps in the guide below — copy the extension and refresh the tab.

---

## Guide

Extension-Multiplayer/ - the extension (everyone needs it)
multiplayer.mjs - server plugin (host only, goes in plugins/)
mp-proxy.mjs - proxy for private tunnel (host only)
README.md - this guide

### HOST (once):
0. Close SillyTavern and all its tabs
1. Copy Extension-Multiplayer/ to data/default-user/extensions/
2. Copy multiplayer.mjs to plugins/ (next to server.js, NOT inside extensions)
3. Copy mp-proxy.mjs to your SillyTavern base folder
4. In config.yaml set:

```yaml
enableServerPlugins: true
disableCsrfProtection: true
whitelistMode: false

listen: true
basicAuthMode: true
basicAuthUser:
  username: your_user
  password: ***

cors:
  enabled: true
  origin: true
  credentials: ***
```

PASSWORD:
In config.yaml: listen: true, basicAuthMode: true, your user/password in basicAuthUser.

5. Start SillyTavern (config and plugins only load at startup)

### CLIENT:
1. Copy Extension-Multiplayer/ to data/default-user/extensions/
2. Refresh the SillyTavern tab and done (no config, no restart, no plugin)

#### PLAYING:

Host:

1. open your chat, open the SillyTavern multiplayer extension, type a password you will give your friends and press Create room.
2. Open a cmd / terminal in the SillyTavern folder, type " node mp-proxy.mjs 8000 8123 your_user your_password "

Keep node mp-proxy.mjs running and point your quick tunnel http there. Share the tunnel URL + the code with your friends. Only the game is visible, your chats are not.

Client:

1. Paste URL + code and press Connect.

To leave: Disconnect.
