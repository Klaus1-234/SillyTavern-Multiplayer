SILLYTAVERN MULTIPLAYER v1.7.10 - STEPS

ZIP FILES:
Extension-Multiplayer/ - the extension (everyone needs it)
multiplayer.mjs - server plugin (host only, goes in plugins/)
mp-proxy.mjs - proxy for private tunnel (host only)
README.md - this guide

HOST (once):
0. Close SillyTavern and all its tabs
1. Copy Extension-Multiplayer/ to data/default-user/extensions/
2. Copy multiplayer.mjs to plugins/ (next to server.js, NOT inside extensions)
3. Copy mp-proxy.mjs to your SillyTavern base folder
4. In config.yaml set:
enableServerPlugins: true
disableCsrfProtection: true
whitelistMode: false
and inside cors: set origin: true and credentials: true (with enabled: true)

PASSWORD:
In config.yaml: listen: true, basicAuthMode: true, your user/password in basicAuthUser.

5. Start SillyTavern (config and plugins only load at startup)

CLIENT:
1. Copy Extension-Multiplayer/ to data/default-user/extensions/
2. Refresh the SillyTavern tab and done (no config, no restart, no plugin)

PLAYING:

Host:

1. open your chat, open the SillyTavern multiplayer extension, type a password you will give your friends and press Create room.
2. Open a cmd / terminal in the SillyTavern folder, type " node mp-proxy.mjs 8000 8123 your_user your_password "

Keep node mp-proxy.mjs running and point your quick tunnel http there. Share the tunnel URL + the code with your friends. Only the game is visible, your chats are not.

Client:

1. Paste URL + code and press Connect.

To leave: Disconnect.
