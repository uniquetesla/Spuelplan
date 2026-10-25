# SpülPilot · Stadtwerke Heppenheim

Webanwendung für Trinkwasserspülungen mit deutscher, responsiver Oberfläche, SQLite-Datenbank und drei serverseitig geprüften Benutzerrollen. Node.js ab Version 24 LTS. Kein externer Datenbankdienst erforderlich.

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

## Listenablauf und gespeicherte Durchgänge

1. Die Administration legt Benutzer, Spüllisten und Spülpunkte an. Der erste Durchgang beginnt mit offenen Punkten. Eine leere Liste geht nicht automatisch zur Prüfung.
2. Eine Liste wird aktiven Mitarbeitern und/oder Administrationskonten freigegeben. Nur diese Personen können im aktuellen Durchgang Messwerte erfassen; Betrachter erhalten keine Bearbeitungsfreigabe.
3. Jeder Punkt kann pro Durchgang einmal bearbeitet werden. Die letzte erforderliche Spülung übergibt den Durchgang automatisch in **Zur Prüfung**. Die Liste verschwindet bei Mitarbeitern, bleibt bei der Administration erhalten und ist für weitere Messungen gesperrt.
4. Die Administration prüft die Protokolle und wählt **Speichern & für Betrachter freigeben**. Erst danach sehen Betrachter diesen Durchgang, seine Punkte und Messwerte und können ihn ausdrucken. Punktstammdaten werden als historische Momentaufnahme gespeichert.
5. Mit **Neuen Durchgang freigeben** wählt die Administration die erneut berechtigten Personen. Alle Punkte sind im neuen Durchgang wieder offen. Gespeicherte Durchgänge bleiben unverändert für Administration und Betrachter erhalten. Neue und ungeprüfte Daten werden Betrachtern auch beim direkten API-Zugriff nicht angezeigt.
6. Die Administration kann Protokolle nach Liste und Durchgang filtern. Betrachter sehen ausschließlich veröffentlichte Durchgänge; Mitarbeiter ausschließlich ihre laufenden Freigaben.

Listen und Protokolle werden niemals automatisch nach Alter gelöscht. Nur die Administration kann eine Liste mit Bestätigung ihres exakten Namens löschen. Dabei werden Liste und alle Durchgänge aus der Anwendung entfernt und die Freigaben entzogen. Die Daten werden intern logisch als gelöscht markiert und nicht automatisch physisch aus der Datenbank entfernt. Das verhindert versehentlichen Datenverlust; ein endgültiges Bereinigungskonzept ist betrieblich festzulegen.

Vorhandene Datenbanken werden ergänzend und ohne Zurücksetzen migriert. Vor der Migration einer gefüllten Datenbank entsteht eine konsistente SQLite-Sicherung neben der Datei. Vorhandene Spülungen bleiben einschließlich früherer Wiederholungsmessungen erhalten und werden dem ersten Durchgang zugeordnet. Vollständige Altdurchgänge landen zur Prüfung bei der Administration, werden aber niemals automatisch für Betrachter veröffentlicht.

Zeitstempel bleiben intern für Reihenfolge und die Ermittlung der letzten Spülung als UTC gespeichert. Oberfläche und Ausdruck zeigen ausschließlich das Kalenderdatum in Europe/Berlin, keine Uhrzeit. Jeder neue Datensatz enthält die damalige Spülpunkt-ID, Adresse, Sollmenge und den Namen der erfassenden Person.

## Sicherheit und Betrieb

- Passwörter: scrypt mit zufälligem individuellem Salt; mindestens 12 Zeichen.
- Sitzungen: zufällige 256-Bit-Tokens; in der Datenbank nur als SHA-256-Hash; feste Laufzeit von 8 Stunden; HttpOnly- und SameSite=Strict-Cookie.
- CSRF-Token und Herkunftsprüfung für schreibende Anfragen, parametrisierte SQL-Abfragen, Content Security Policy, escapte Benutzereingaben.
- Login-Drosselung nach Konto/IP und insgesamt nach Verbindungs-IP. Hinter einem Reverse Proxy ist die Verbindungs-IP die des Proxys; für größere Installationen zusätzlich am Proxy drosseln.
- Deaktivierte Benutzer verlieren ihre Sitzungen und Freigaben. Passwort- und Rollenänderungen beenden bestehende Sitzungen. Der eigene Administrationszugang kann sich nicht selbst deaktivieren oder herabstufen.
- Neue Benutzer werden von der Administration verwaltet. Alle Rollen können ihr eigenes Passwort unter **Mein Passwort** mit dem bisherigen Passwort ändern. Ein Rücksetzen ohne Anmeldung per E-Mail, E-Mail-Einladungen und Zwei-Faktor-Authentifizierung sind noch nicht implementiert.

Für den ortsunabhängig erreichbaren, internen Betrieb HTTPS vor dem Node-Prozess terminieren und die **exakte öffentliche Herkunft** setzen, beispielsweise:

```sh
APP_ORIGIN=https://spuelplan.example.de COOKIE_SECURE=true HOST=127.0.0.1 PORT=3000 npm start
```

`APP_ORIGIN` muss ohne abschließenden Schrägstrich angegeben werden. Bei `COOKIE_SECURE=true` werden Cookies ausschließlich über HTTPS übertragen und HSTS aktiviert. Niemals HTTP und unsichere Cookies für den von außen erreichbaren Betrieb verwenden. Vorher Demo-Datenbank durch persönliche produktive Datenbank ersetzen, persönliche Konten einrichten, Zugriffe und Backups absichern. Die Anwendung ist nicht veröffentlicht; Domain, TLS und Hosting sind separat einzurichten.

Konfiguration: `PORT` (3000), `HOST` (0.0.0.0), `DB_PATH`, `APP_ORIGIN`, `COOKIE_SECURE`, `DEMO_MODE`, `DEMO_PASSWORD` (nur für das initiale Demo-Seeding). Geheimnisse nicht in Git eintragen.

## Entwicklung und Tests

```sh
npm run dev
npm test
```

Die Integrationstests verwenden temporäre Datenbanken und prüfen Anmeldung, Rechte, den vollständigen Listenablauf über mehrere Durchgänge, Veröffentlichung, historische Snapshots, Löschung, Dublettenschutz und die sichere Migration bestehender Datenbanken.

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

Er setzt eine angemeldete, freigegebene Sitzung der Rolle Administration oder Mitarbeiter, passende Origin und den CSRF-Header voraus. Datum, Benutzer und Herkunft der Aufzeichnung werden serverseitig vergeben; Clients können diese nicht überschreiben. Aktuell ist die Quelle immer `manual`.

Für die eigentliche Integration sind BLE-Service-/Characteristic-UUIDs, Einheiten, Messwertformat, Messbeginn/-ende, Kalibrierung und Wiederverbindungsverhalten mit der Firmware abzustimmen. Anschließend kann ein Bluetooth-Adapter Messwerte ins Formular übertragen und vor dem Speichern durch den Mitarbeiter bestätigen lassen. Zusätzlich sind Idempotenz und eine authentifizierte Quellenerkennung vor automatischen Übertragungen umzusetzen. Web Bluetooth benötigt HTTPS und einen kompatiblen Browser (z. B. Chrome auf Android); iOS Safari unterstützt es nicht. Für iPhones wird daher eine kompatible App-/Bridge-Lösung benötigt.

### Festgelegter Messablauf für die spätere Firmware

1. Das Smartphone ist per Bluetooth mit dem ESP32 verbunden. Eine freigegebene Person wählt einen Spülpunkt aus.
2. Spülpunkt-ID und Sollmenge in m³ werden als Auftrag an das Gerät übertragen. Das Gerät muss den Auftrag bestätigen; Messwerte gehören eindeutig zu diesem Auftrag.
3. Die tatsächliche Spülmenge wird ab Beginn dieses Auftrags gezählt. Sobald erstmals ein Durchfluss von **mindestens 1 m³/h** erreicht wird (einschließlich exakt 1 m³/h), beginnt eine **Wartezeit von 5 Sekunden**. Danach wird die Temperatur vorher gemessen und für diesen Auftrag festgehalten.
4. Sobald die aufsummierte Spülmenge die Sollmenge **erreicht oder überschreitet**, wird die Temperatur nachher automatisch erfasst. Übertragen wird die tatsächlich gemessene Menge, auch wenn sie über der Sollmenge liegt.
5. Messwerte werden automatisch dem ausgewählten Spülpunkt zugeordnet. Trübung bleibt eine manuelle Ja/Nein-Angabe, solange kein entsprechender Sensor vereinbart ist. Im sichtbaren Protokoll erscheint nur das Spüldatum.

Die 5 Sekunden beziehen sich auf das erstmalige Erreichen der Durchflussschwelle; ein Neustart bei Unterschreitung ist bisher nicht vereinbart. Ist die Sollmenge bereits vor der Vorher-Messung erreicht, fehlen Messwerte oder bricht die Verbindung ab, darf kein vollständiges Protokoll behauptet werden. Ein Wechsel des Spülpunkts während eines laufenden Auftrags muss verhindert bzw. der Auftrag ausdrücklich abgebrochen werden. Gerätezeit, Sequenznummern und eine Auftrags-ID werden für Zuordnung, Wiederverbindung und Schutz vor Doppelübertragungen benötigt; sie werden nicht als Uhrzeit im Benutzerprotokoll angezeigt. Eine Ventilabschaltung ist mit dieser Beschreibung nicht beauftragt.

Dieser Ablauf ist als Integrationsanforderung festgehalten; die aktuelle Website erfasst Messwerte weiterhin manuell und steuert noch kein reales Gerät.

## Interne Erreichbarkeit

SpülPilot ist ausschließlich für berechtigte Personen der Stadtwerke Heppenheim vorgesehen. Es gibt keine öffentliche Registrierung und keine ohne Anmeldung abrufbaren Arbeitsdaten. Die IT stellt die ortsunabhängige Erreichbarkeit über HTTPS und die betrieblich vorgesehenen Zugangswege bereit. Eine konkrete, noch nicht installierte Proxyvorlage und Betriebsanweisungen stehen unter [deploy/README.md](deploy/README.md).

## Persönliche Passwörter und Einmalpasswörter

Jede Rolle hat den Menüpunkt **Mein Passwort**. Ein persönlicher Passwortwechsel benötigt das bisherige Passwort, zweimal das neue Passwort und mindestens 12 Zeichen. Die aktuelle Sitzung wird erneuert; alle anderen Sitzungen dieses Kontos werden beendet.

Unter **Team & Zugänge → Einmalpasswort erstellen** kann die Administration für ein anderes aktives Konto ein neues, zufällig gewähltes Einmalpasswort aus Tier-/Gegenstandsname und vier Zahlen erzeugen, z. B. im Format `Giraffe` + `1234` oder `Lampe` + `0815`. Es erscheint nur einmal im geöffneten Dialog und wird weder im Browser gespeichert noch im Klartext in der Datenbank abgelegt. Nach dem Schließen kann die Administration es nicht erneut abrufen, sondern nur ein neues erzeugen. Übermittlung persönlich über einen sicheren betrieblichen Kanal.

Einmalpasswörter sind bewusst einfach, deshalb **10 Minuten gültig**, nur für **eine Anmeldung** nutzbar und durch kontoübergreifend über IPs hinweg wirkende Login-Drosselung geschützt. Ein neues Einmalpasswort ersetzt das alte und beendet sämtliche bestehenden Sitzungen des Zielkontos. Die anschließende Sitzung ist auf den Pflichtwechsel beschränkt: nur eigenes Passwort setzen, Sitzungsinformationen und Abmeldung sind möglich. Listen und Verwaltungsfunktionen sind serverseitig gesperrt, auch für Administrationskonten. Erst nach dem Speichern eines neuen persönlichen Passworts wird der normale Zugriff freigeschaltet. Bei verlorenem oder abgelaufenem Einmalpasswort oder abgebrochenem Pflichtwechsel muss die Administration ein neues erzeugen.

Das eigene Administrationspasswort wird unter **Mein Passwort** geändert. Bestehende Benutzerpasswörter können nicht mehr über das allgemeine Bearbeitungsformular gesetzt werden. Neue Benutzer behalten den bisherigen Anlageablauf mit einem mindestens zwölf Zeichen langen Anfangspasswort; bei Bedarf kann danach ein Einmalpasswort erzeugt werden. Bestandskonten bleiben bei der ergänzenden Datenbankmigration unverändert.

Betrachter sehen **Geräte & Sensoren** nicht; auch der direkte Aufruf dieses Bereichs führt zurück zur Übersicht. Die tatsächliche ESP32-Anbindung folgt erst nach Abstimmung des Sende- und Empfangsformats.
