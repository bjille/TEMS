# TEMS — Home Assistant Energiemanagement Platform

Multi-tenant platform waarop bewoners hun eigen woning-data uit hun eigen Home
Assistant-instantie kunnen zien (batterij, zonnepanelen, elektriciteitsprijzen,
verbruik) en stuurbare stopcontacten/batterij kunnen bedienen. Admins beheren
woningen en welke HA-entities als "parameter" getoond worden.

## Structuur

- `backend/` — Node.js/Express API, MongoDB (Mongoose), Socket.io, HA WebSocket-client
- `frontend/` — React + Redux Toolkit (Vite)

## Snel starten

### Vereisten
- Node.js 16+ en een lokale of remote MongoDB
- Een Home Assistant-instantie met een long-lived access token, extern bereikbaar (bv. via Nabu Casa of een eigen reverse proxy)

### Backend
```bash
cd backend
cp .env.example .env   # vul MONGO_URI, JWT secrets en ENCRYPTION_KEY in
npm install
npm run seed            # maakt een demo superadmin user aan
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

De frontend draait op http://localhost:5173 en praat met de backend op
http://localhost:4000 (zie `frontend/.env` / `VITE_API_URL`).

## Architectuur (kort)

- Elke woning heeft een eigen HA-URL + long-lived token. De backend houdt per
  actieve woning één WebSocket-verbinding met HA open en subscribet op
  `state_changed` events van de entities die als "parameter" zijn geconfigureerd.
- Elke state-change wordt opgeslagen in MongoDB (`readings`) en via Socket.io
  live doorgestuurd naar ingelogde gebruikers van die woning.
- Rechten: `superadmin` beheert woningen/parameters/users platform-breed;
  gewone users zijn via `woningUsers` gekoppeld aan één of meerdere woningen.

Zie `PLAN.md` (indien aanwezig) of de projectgeschiedenis voor het volledige
ontwerp, inclusief de latere fase met automatisch energiemanagement
(prijs/weer/EV-gebaseerde optimalisatie).
