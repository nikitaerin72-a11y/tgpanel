---
title: tg panel
emoji: 📦
colorFrom: gray
colorTo: black
sdk: docker
app_port: 7860
pinned: false
---

# tg panel

Панель приёма дампов и команд. Node + Express, один файл `server.js`.

## Переменные окружения

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `7860` | порт (Render/Koyeb подставляют свой) |
| `DATA_DIR` | папка с кодом | куда писать `dumps/`, `media/`, `*.json` |
| `UPLOAD_KEY` | `change_me_upload` | ключ для устройств (`x-key`) |
| `VIEW_KEY` | `change_me_view` | ключ доступа к панели (`?key=`) |

## Запуск

```bash
npm install
UPLOAD_KEY=... VIEW_KEY=... npm start
```

Docker:

```bash
docker build -t tgpanel .
docker run -p 7860:7860 -e VIEW_KEY=... -e UPLOAD_KEY=... -v tgdata:/data tgpanel
```
