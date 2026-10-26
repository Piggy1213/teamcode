'use strict';
// Renders build/icon.png (1024x1024) with Electron. Run: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:grid;place-items:center">
  <div style="width:824px;height:824px;border-radius:190px;background:linear-gradient(135deg,#6d4aff 0%,#4f7dff 55%,#2fb7e5 100%);display:grid;place-items:center;box-shadow:0 30px 60px rgba(40,20,120,.35);position:relative;overflow:hidden">
    <div style="position:absolute;inset:0;background:radial-gradient(circle at 30% 20%,rgba(255,255,255,.35),transparent 55%)"></div>
    <div style="font:800 380px/1 -apple-system,'Segoe UI',sans-serif;color:#fff;letter-spacing:-20px;position:relative">TC</div>
    <div style="position:absolute;bottom:120px;display:flex;gap:34px">${['#fff', '#fff', '#fff'].map(() => '<div style="width:54px;height:54px;border-radius:50%;background:rgba(255,255,255,.9)"></div>').join('')}</div>
  </div>
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
