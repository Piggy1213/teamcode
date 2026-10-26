'use strict';
// Renders build/icon.png (1024x1024) with Electron. Run: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:grid;place-items:center">
  <svg width="824" height="824" viewBox="0 0 24 24" style="filter:drop-shadow(0 12px 24px rgba(0,0,0,.28))">
    <rect width="24" height="24" rx="5.5" fill="#161615"/>
    <path d="M7.5 6.5v11M12 6.5v6.5" stroke="#f1f0ec" stroke-width="2.3" stroke-linecap="round"/>
    <path d="M16.5 6.5v9" stroke="#ff6a30" stroke-width="2.3" stroke-linecap="round"/>
  </svg>
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
