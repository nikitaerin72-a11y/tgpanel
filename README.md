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

## Доступ

`VIEW_KEY` можно передавать в `?key=`, а можно один раз открыть `/?key=...` — сервер положит его в
HttpOnly-cookie `pk`, и дальше все ссылки, `<img src="/media/…">` и `fetch('/api/state')` работают
без ключа в URL. `/media` без ключа или cookie отдаёт 403.

## API

| Роут | Ключ | Что делает |
|---|---|---|
| `POST /log`, `POST /ping` | `x-key: UPLOAD_KEY` | устройство отмечается на панели |
| `POST /upload` | `x-key` | приём zip-дампа |
| `POST /cmd/poll` | `x-key` | long-poll очереди команд устройства |
| `POST /cmd/result` | `x-key` | результат команды + файл |
| `POST /stream/frame` | `x-key` | кадр JPEG для MJPEG-потока |
| `GET /stream/:device` | `?key=` / cookie | сам поток |
| `GET /cmd/send` | `?key=` / cookie | поставить команду |
| `GET /cmd/cancel` | `?key=` / cookie | снять команду из очереди |
| `GET /api/state` | cookie | JSON для живого обновления обзора |

## Тесты

```bash
UPLOAD_KEY=testup VIEW_KEY=testview PORT=7999 node server.js &
UPLOAD_KEY=testup VIEW_KEY=testview BASE=http://127.0.0.1:7999 npm test
```
