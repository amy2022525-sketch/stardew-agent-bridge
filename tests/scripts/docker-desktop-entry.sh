#!/usr/bin/env bash
# Isolated graphical test fixture. Never starts SMAPI or a game.
set -euo pipefail
export HOME=/tmp/desktop-home DISPLAY=:99 XAUTHORITY=/tmp/qa.auth
mkdir -p "$HOME"
touch "$XAUTHORITY"
chmod 600 "$XAUTHORITY"
cookie=$(mcookie)
xauth -f "$XAUTHORITY" add :99 . "$cookie"
unset cookie
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -auth "$XAUTHORITY" > /tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do if xdpyinfo -display :99 > /dev/null 2>&1; then break; fi; sleep 0.1; done
xdpyinfo -display :99 > /tmp/display-info
openbox --sm-disable > /tmp/openbox.log 2>&1 &
if command -v xmessage > /dev/null; then
  xmessage -center 'Stardew Agent Bridge: noVNC desktop validation. No game is running.' > /tmp/xmessage.log 2>&1 &
fi
x11vnc -display :99 -auth "$XAUTHORITY" -localhost -rfbport 5900 -passwdfile /run/secrets/sab_vnc_password -forever -shared -nosel > /tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 127.0.0.1:6081 127.0.0.1:5900 > /tmp/websockify.log 2>&1 &
exec node /opt/sab/container/desktop-gateway.mjs
