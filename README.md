# Spülplan

Webanwendung für Trinkwasserspülungen mit deutscher, responsiver Oberfläche, SQLite-Datenbank und drei serverseitig geprüften Benutzerrollen. Node.js ab 22.13 (empfohlen: Node 24 LTS). Kein externer Datenbankdienst erforderlich.

## Start

```sh
npm ci
npm start
```

Der Server lauscht standardmäßig auf Port 3000. Beim ersten Start entsteht `data/setup-token` mit einem zufälligen Einrichtungsschlüssel. Den Schlüssel **auf dem eigenen Server** auslesen, in der Einrichtungsmaske eingeben und ein persönliches Administrationskonto erstellen. Die Datei wird danach gelöscht. Es gibt im normalen Betrieb keine Standardkonten oder Standardpasswörter.

Die SQLite-Datenbank liegt in `data/spuelplan.sqlite`. `data/` ist von Git ausgeschlossen. Datenbank und zugehörige WAL-Dateien persistent speichern; für Backups die SQLite-Backupfunktion bzw. einen gestoppten Server verwenden. Ein reiner Git-Checkout enthält keine Daten.

### Demo

```sh
read -r -s -p 'Eigenes Demo-Passwort (mindestens 12 Zeichen): ' DEMO_PASSWORD
export DEMO_PASSWORD
DEMO_MODE=true DB_PATH=./data/demo.sqlite npm start
```

Die Beispieldaten werden ausschließlich in eine leere Datenbank eingetragen. Die UI kennzeichnet den Demomodus ausdrücklich. Für alle drei Beispielkonten gilt das beim ersten Start gesetzte `DEMO_PASSWORD`:

- Administration: `admin@spuelplan.local`
- Mitarbeiter: `lena@spuelplan.local`
- Betrachter: `betrachter@spuelplan.local`

Verwende ein eigenes Passwort **ausschließlich für eine lokale Demo**. Eine Demo nicht öffentlich mit diesen Zugangsdaten betreiben. Ein anderes `DEMO_PASSWORD` beim Neustart ändert bestehende Konten nicht. Die aktuelle Cloud-Entwicklungsinstanz nutzt diese separate Demo-Datenbank.

## Ablauf

1. Administration legt Benutzer unter **Team & Zugänge** an.
2. Administration erstellt eine Spülliste und darin Spülpunkte mit eindeutiger ID, Adresse und Sollmenge in m³.
3. Unter **Freigabe** werden einer Liste ein oder mehrere aktive Mitarbeiter zugeordnet. Die Freigabe gilt auch für später hinzugefügte Punkte.
4. Mitarbeiter sehen ausschließlich ihre freigegebenen Listen und erfassen Temperatur vorher/nachher, tatsächliche Menge und Trübung (Ja/Nein). Serverzeit und angemeldeter Mitarbeiter werden automatisch eingetragen.
5. Betrachter sehen alle Listen und Protokolle, können nach Liste bzw. Text filtern und die gefilterte Liste drucken oder über den Browser als PDF speichern. Administration kann ebenfalls Protokolle lesen und drucken, führt aber keine Spülungen aus.

„Dokumentiert“ bedeutet mindestens ein gespeichertes Protokoll, keine Aussage über eine terminliche Fälligkeit. Wiederholte Spülungen sind möglich. Die letzte Spülung wird aus dem neuesten Protokoll ermittelt. Protokolle werden nicht überschrieben; ID, Adresse, Sollmenge und Mitarbeitername werden als historische Momentaufnahme gespeichert. Zeitstempel werden als UTC gespeichert und in der Oberfläche in Europe/Berlin angezeigt.

## Sicherheit und Betrieb

- Passwörter: scrypt mit zufälligem individuellem Salt; mindestens 12 Zeichen.
- Sitzungen: zufällige 256-Bit-Tokens; in der Datenbank nur als SHA-256-Hash; feste Laufzeit von 8 Stunden; HttpOnly- und SameSite=Strict-Cookie.
- CSRF-Token und Herkunftsprüfung für schreibende Anfragen, parametrisierte SQL-Abfragen, Content Security Policy, escapte Benutzereingaben.
- Login-Drosselung nach Konto/IP und insgesamt nach Verbindungs-IP. Hinter einem Reverse Proxy ist die Verbindungs-IP die des Proxys; für größere Installationen zusätzlich am Proxy drosseln.
- Deaktivierte Benutzer verlieren ihre Sitzungen und Freigaben. Passwort- und Rollenänderungen beenden bestehende Sitzungen. Der eigene Administrationszugang kann sich nicht selbst deaktivieren oder herabstufen.
- Neue Benutzer und Passwortänderungen werden von der Administration verwaltet. Passwort-Selbstzurücksetzung, E-Mail-Einladungen und Zwei-Faktor-Authentifizierung sind noch nicht implementiert.

Für einen öffentlichen Betrieb HTTPS vor dem Node-Prozess terminieren und die **exakte öffentliche Herkunft** setzen, beispielsweise:

```sh
APP_ORIGIN=https://spuelplan.example.de COOKIE_SECURE=true HOST=127.0.0.1 PORT=3000 npm start
```

`APP_ORIGIN` muss ohne abschließenden Schrägstrich angegeben werden. Bei `COOKIE_SECURE=true` werden Cookies ausschließlich über HTTPS übertragen und HSTS aktiviert. Niemals HTTP und unsichere Cookies für einen öffentlichen Betrieb verwenden. Vorher Demo-Datenbank durch persönliche produktive Datenbank ersetzen, persönliche Konten einrichten, Zugriffe und Backups absichern. Die Anwendung ist nicht veröffentlicht; Domain, TLS und Hosting sind separat einzurichten.

Konfiguration: `PORT` (3000), `HOST` (0.0.0.0), `DB_PATH`, `APP_ORIGIN`, `COOKIE_SECURE`, `DEMO_MODE`, `DEMO_PASSWORD` (nur für das initiale Demo-Seeding). Geheimnisse nicht in Git eintragen.

## Entwicklung und Tests

```sh
npm run dev
npm test
```

Die acht Integrationstests starten eine eigene temporäre Datenbank. Sie prüfen Ersteinrichtung, Login, CSRF, Rollenrechte, Listenfreigaben, Eingabevalidierung, Zeitstempel, historische Werte, Freigabeentzug, Deaktivierung und Abmeldung.

Der zusätzliche Browser-Smoke-Test erstellt in einer temporären Datenbank eine Liste samt Punkt, gibt sie frei, dokumentiert als Mitarbeiter eine Spülung, prüft den Betrachter-Ausdruck als PDF und die mobile Navigation:

```sh
npx playwright install chromium
npm run test:ui
```

Alternativ vorhandenes Chromium verwenden (so wurde in der Cloud getestet):

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui
```

Es gibt keinen separaten Build-Schritt: Express liefert HTML, CSS und JavaScript aus `public/` direkt aus. Browser und Server benötigen zur Laufzeit keine externen Schriftarten, CDNs oder APIs.

## Spätere ESP32-Schnittstelle

Bluetooth ist noch **nicht implementiert**. Die Seite **Geräte & Sensoren** erklärt den geplanten Ablauf. Der vorhandene Endpunkt `POST /api/points/:id/flushes` nimmt bereits normalisierte Messwerte entgegen:

```json
{
  "temperature_before": 22.5,
  "temperature_after": 14.2,
  "volume": 2.7,
  "turbidity": false
}
```

Er setzt eine angemeldete, freigegebene Mitarbeiter-Sitzung, passende Origin und den CSRF-Header voraus. Datum, Benutzer und Herkunft der Aufzeichnung werden serverseitig vergeben; Clients können diese nicht überschreiben. Aktuell ist die Quelle immer `manual`.

Für die eigentliche Integration sind BLE-Service-/Characteristic-UUIDs, Einheiten, Messwertformat, Messbeginn/-ende, Kalibrierung und Wiederverbindungsverhalten mit der Firmware abzustimmen. Anschließend kann ein Bluetooth-Adapter Messwerte ins Formular übertragen und vor dem Speichern durch den Mitarbeiter bestätigen lassen. Zusätzlich sind Idempotenz und eine authentifizierte Quellenerkennung vor automatischen Übertragungen umzusetzen. Web Bluetooth benötigt HTTPS und einen kompatiblen Browser (z. B. Chrome auf Android); iOS Safari unterstützt es nicht. Für iPhones wird daher eine kompatible App-/Bridge-Lösung benötigt.
