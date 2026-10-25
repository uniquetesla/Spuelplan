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

Protokoll- und BLE-Client-Tests prüfen Format, Statusmeldungen und Bestätigungsablauf mit einem simulierten Gerät. Die API-Integrationstests verwenden temporäre Datenbanken und prüfen Anmeldung, Rechte, den vollständigen Listenablauf über mehrere Durchgänge, Veröffentlichung, historische Snapshots, Löschung, Dublettenschutz und die sichere Migration bestehender Datenbanken.

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

## ESP32 über Bluetooth Low Energy

Die Browseranbindung verwendet das vereinbarte Profil von **SpuelPilot-ESP32** und ist im Spülformular sowie unter **Geräte & Sensoren** verfügbar. Nach dem Verbinden wird der Sende-/Abrufbutton aktiv. Aufträge werden als `ID;Sollmenge` geschrieben; GET fordert `ID;Istmenge;Temperatur vorher;Temperatur nachher` per Notification an. Nach der Übernahme ergänzt die Bedienperson die Trübung und speichert das Protokoll.

**ACK wird erst nach bestätigter Serverspeicherung gesendet.** Erst dann löscht die Firmware ihr Ergebnis und schaltet ihre Status-LED aus. Bei Speicher- oder Verbindungsfehlern bleiben Gerätedaten erhalten. Wiederholte HTTP-Anfragen werden anhand einer Übertragungs-ID ohne doppelte Protokolle bearbeitet. Ausstehende Bestätigungen sind nach Anmeldung im selben Browser wiederaufnehmbar.

Profil, exakte UUIDs, alle Telegramme, der Messablauf und das Wiederaufnahmeverfahren stehen im [BLE-Vertrag](docs/esp32-ble.md). Web Bluetooth benötigt HTTPS und einen unterstützten Browser. iOS Safari unterstützt es nicht. Die Firmware muss vollständige Nachrichten, Status-LED und Ergebnisaufbewahrung bis zum ACK umsetzen.

Die Cloudtests simulieren einen ESP32 einschließlich Notifications, Read, LED-Zustand und Fehlerfällen. Eine Prüfung mit realer Hardware steht noch aus.

## Interne Erreichbarkeit

SpülPilot ist ausschließlich für berechtigte Personen der Stadtwerke Heppenheim vorgesehen. Es gibt keine öffentliche Registrierung und keine ohne Anmeldung abrufbaren Arbeitsdaten. Die IT stellt die ortsunabhängige Erreichbarkeit über HTTPS und die betrieblich vorgesehenen Zugangswege bereit. Eine konkrete, noch nicht installierte Proxyvorlage und Betriebsanweisungen stehen unter [deploy/README.md](deploy/README.md).

## Persönliche Passwörter und Einmalpasswörter

Jede Rolle hat den Menüpunkt **Mein Passwort**. Ein persönlicher Passwortwechsel benötigt das bisherige Passwort, zweimal das neue Passwort und mindestens 12 Zeichen. Die aktuelle Sitzung wird erneuert; alle anderen Sitzungen dieses Kontos werden beendet.

Unter **Team & Zugänge → Einmalpasswort erstellen** kann die Administration für ein anderes aktives Konto ein neues, zufällig gewähltes Einmalpasswort aus Tier-/Gegenstandsname und vier Zahlen erzeugen, z. B. im Format `Giraffe` + `1234` oder `Lampe` + `0815`. Es erscheint nur einmal im geöffneten Dialog und wird weder im Browser gespeichert noch im Klartext in der Datenbank abgelegt. Nach dem Schließen kann die Administration es nicht erneut abrufen, sondern nur ein neues erzeugen. Übermittlung persönlich über einen sicheren betrieblichen Kanal.

Einmalpasswörter sind bewusst einfach, deshalb **10 Minuten gültig**, nur für **eine Anmeldung** nutzbar und durch kontoübergreifend über IPs hinweg wirkende Login-Drosselung geschützt. Ein neues Einmalpasswort ersetzt das alte und beendet sämtliche bestehenden Sitzungen des Zielkontos. Die anschließende Sitzung ist auf den Pflichtwechsel beschränkt: nur eigenes Passwort setzen, Sitzungsinformationen und Abmeldung sind möglich. Listen und Verwaltungsfunktionen sind serverseitig gesperrt, auch für Administrationskonten. Erst nach dem Speichern eines neuen persönlichen Passworts wird der normale Zugriff freigeschaltet. Bei verlorenem oder abgelaufenem Einmalpasswort oder abgebrochenem Pflichtwechsel muss die Administration ein neues erzeugen.

Das eigene Administrationspasswort wird unter **Mein Passwort** geändert. Bestehende Benutzerpasswörter können nicht mehr über das allgemeine Bearbeitungsformular gesetzt werden. Neue Benutzer behalten den bisherigen Anlageablauf mit einem mindestens zwölf Zeichen langen Anfangspasswort; bei Bedarf kann danach ein Einmalpasswort erzeugt werden. Bestandskonten bleiben bei der ergänzenden Datenbankmigration unverändert.

Betrachter sehen **Geräte & Sensoren** nicht; auch der direkte Aufruf dieses Bereichs führt zurück zur Übersicht. Die ESP32-Anbindung folgt dem bestätigten Sende- und Empfangsformat; siehe BLE-Vertrag.

### Messung abbrechen

Im laufenden BLE-Auftrag steht **Messung abbrechen** zur Verfügung. Es wird das vorhandene Auftragsformat mit der Sondermenge null verwendet, etwa `SP-1024;0`; kein neuer Befehl wird eingeführt. Dazu muss die ESP32-Firmware die [Abbrucherweiterung](docs/esp32-ble.md#messung-abbrechen-ohne-neuen-befehlsnamen) implementieren; ein zusätzlicher Firmware-Check in der Oberfläche entfällt. Ein fertiges, ungespeichertes Ergebnis bleibt geschützt. Der Abbruch erzeugt keinen Spülnachweis und schließt kein Ventil. Er gilt erst nach Gerätebestätigung als erfolgreich; unklare Abbrüche bleiben wiederaufnehmbar.

## Interne Bemerkungen und quittierbare Hinweise

Beim Erfassen einer Spülung kann eine interne Bemerkung mit bis zu 2.000 Zeichen ergänzt werden, etwa zur Meldung eines Defekts. Sie wird zusammen mit dem Protokoll atomar in einer getrennten internen Tabelle gespeichert und nicht an den ESP32 übertragen. Übertragungswiederholungen mit abweichender Bemerkung werden abgewiesen.

**Interne Hinweise** zeigt offene Bemerkungen separat nach Spülpunkt gruppiert und rot hervorgehoben an. Die Administration sieht alle Hinweise; Mitarbeiter sehen ihre eigenen und die Hinweise ihrer freigegebenen Listen, auch nach Übergabe zur Prüfung. Mit **Quittieren** werden genau die angezeigten Bemerkungen quittiert und ausgeblendet. Neu hinzukommende Bemerkungen bleiben offen. Die Texte werden nicht gelöscht; Quittierung, Person und Datum bleiben intern erhalten.

Betrachter sehen weder Menüpunkt noch Hinweis-Markierungen oder Bemerkungstexte. Die Hinweise liegen nicht in der allgemeinen Protokollantwort oder den Speicherbestätigungen; die separate API verweigert Betrachtern den Zugriff. Auch Drucklisten enthalten keine Bemerkungen. Das gilt ebenfalls nach Veröffentlichung eines Durchgangs.

Beim Start einer neuen BLE-Messung fragt SpülPilot vor dem Abbruch eines laufenden Auftrags immer nach. Der Neustart erfolgt nur nach bestätigtem Abbruch; ein abgelehnter oder fehlgeschlagener Abbruch überschreibt den alten Auftrag nicht.
