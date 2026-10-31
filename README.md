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
- Sitzungen: zufällige 256-Bit-Tokens; in der Datenbank nur als SHA-256-Hash; 30 Tage Gültigkeit, bei Nutzung höchstens einmal täglich wieder auf 30 Tage verlängert; HttpOnly- und SameSite=Strict-Cookie.
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

### Gespeicherte Spüllisten

Nach dem letzten offenen Spülpunkt wechselt der Durchlauf zur Prüfung. Sämtliche Bearbeitungsfreigaben für Mitarbeiter und Administration werden entfernt. Erst die Administration veröffentlicht den geprüften Durchlauf zur Betrachtung.

Betrachter sehen jeden veröffentlichten Durchlauf als eigene Spülliste mit dem Datum der Freigabe zur Betrachtung. Zwei Durchläufe derselben Liste erscheinen als zwei Einträge. Beim Öffnen werden ausschließlich die Messungen dieses Durchlaufs mit ihren ursprünglichen Messdaten angezeigt (Datum ohne Uhrzeit). Die Liste lässt sich direkt ausdrucken. Gespeicherte Durchläufe bleiben beim Neustart erhalten; für den neuen Durchlauf müssen berechtigte Personen neu ausgewählt werden.

Unter **Spülprotokolle** wird jeder verfügbare Durchlauf als eigene Spülliste dargestellt. Nach Auswahl erscheinen ausschließlich dessen Messungen. Der Druckbutton ist erst in dieser Detailansicht vorhanden; der Ausdruck enthält nur die ausgewählte Liste und den ausgewählten Durchlauf.

### Administration: Löschungen und Statistik

In der Detailansicht unter **Spülprotokolle** kann die Administration einzelne Messprotokolle über **Protokoll löschen** oder einen abgeschlossenen Durchlauf über **Durchlauf löschen** entfernen. Die Bestätigung verlangt die Spülpunkt-ID beziehungsweise den Listennamen. Aktive Durchläufe können nicht als abgeschlossene Liste gelöscht werden. Die Listenvorlage und andere Durchläufe bleiben erhalten. Eine gelöschte Messung öffnet den Punkt nur in einem noch aktiven Durchlauf; abgeschlossene Durchläufe bleiben geschlossen. Nach dem Löschen des letzten abgeschlossenen Durchlaufs kann die Vorlage erneut freigegeben werden.

Löschungen werden dauerhaft mit Zeitpunkt und Administrator markiert. Gelöschte Daten verschwinden aus Listen, Protokollen, Ausdrucken, internen Hinweisen und Statistik. Alte ESP32-Übertragungen können gelöschte Protokolle nicht wiederherstellen und erhalten keine Speicherbestätigung mehr.

Unter **Team & Zugänge → Einstellungen** setzt **Statistik zurücksetzen** nach Eingabe von `STATISTIK ZURÜCKSETZEN` die gezählten Spülungen und gespülten m³ für alle Benutzer zurück. Neue Messungen zählen ab diesem Zeitpunkt wieder. Protokolle, Listenvorlagen, Spülpunkte und deren Bearbeitungsstand bleiben erhalten. Der Reset wird über eine dauerhafte Messungs-ID-Grenze gespeichert und bleibt nach Serverneustart bestehen; die jeweiligen Rollen- und Freigabebeschränkungen gelten weiter.

### ESP32 Live-Anzeige

Die bestehende TX-Characteristic verarbeitet zusätzlich `LIVE;STATUS;ID;DURCHFLUSS;TEMPERATUR;IST_M3;SOLL_M3;PROZENT;RESTZEIT_SEKUNDEN`. Durchfluss und Temperatur erscheinen schon ohne Auftrag; während der Messung kommen Fortschrittsbalken, Mengen und geschätzte Restzeit hinzu. Werte veralten nach fünf Sekunden und werden bei Bluetooth-Trennung sofort ausgeblendet. Der ESP32 misst autonom weiter.

READY fordert automatisch das vollständige GET-Ergebnis an und speichert über die bisherige idempotente Serverlogik, mit der Trübungsangabe (standardmäßig **Nein – keine Trübung**). Ohne Trübungsangabe bleibt die Messung zur Ergänzung offen. ACK wird ausschließlich nach bestätigter Serverspeicherung gesendet. Die vorhandenen UUIDs, Datenbankstrukturen, Messabbruch und manuellen Wiederholungswege bleiben erhalten. Details zu vollständigen Telegrammen, MTU-Grenzen von Web Bluetooth und TX Read stehen im [BLE-Vertrag](docs/esp32-ble.md).

Spülpunkte lassen sich über die gesamte Tabellenzeile öffnen, per Antippen/Klick sowie mit Enter oder Leertaste. Berechtigungen bleiben unverändert; vorhandene Zeilenbuttons behalten ihre eigene Funktion.

### Zeilenfarben und dauerhafte Anmeldung

Spülpunkte sind während der Erfassung bzw. eines offenen lokalen ESP32-Auftrags gelb, nach gespeicherter Bearbeitung grün und bei einer offenen internen Bemerkung rot. Rot hat Vorrang. Nach Quittierung einer Bemerkung gilt wieder der normale Bearbeitungsstatus. Die Trübung ist bei neuen Messungen mit **Nein – keine Trübung** vorbelegt; eine vorhandene Auswahl für einen offenen Auftrag bleibt erhalten.

Normale Anmeldungen verwenden ein persistentes Cookie mit 30 Tagen Gültigkeit. Bei Nutzung wird die Laufzeit höchstens einmal täglich erneut auf 30 Tage verlängert. Nach 30 Tagen ohne Zugriff ist eine neue Anmeldung nötig. Abmeldung, Passwortänderung, Passwortreset und Kontosperrung widerrufen Sitzungen weiterhin; Sitzungen für den erzwungenen Wechsel eines Einmalpassworts bleiben auf zehn Minuten begrenzt und werden nicht verlängert.

### Durchflussmessung ohne Spülauftrag

Unter **Durchflussmessung** können Mitarbeiter eigene Messungen mit Adresse, Bemerkung und einem gespeicherten Durchflussdiagramm erstellen und verwalten. Die Administration hat Zugriff auf alle Messungen; Betrachter haben weder Menü- noch API-Zugriff. Temperaturen werden nicht erfasst. Die Aufzeichnung nutzt die vorhandenen LIVE-Notifications und läuft ohne Sollmenge bis **Messung beenden**.

Die Messwerte werden fortlaufend lokal gesichert und an den Server übertragen. Nach Netzproblemen können ausstehende Werte auch nach einem Reload übertragen werden. Bluetooth-/Browser-Unterbrechungen werden als Lücken dargestellt. Für eine durchgehende Aufzeichnung müssen Webseite und Bluetooth-Verbindung aktiv bleiben. Neue separate Tabellen speichern diese Kurven, ohne bestehende Spülprotokolle oder die Spülstatistik zu verändern. Bedienung und technische Details: [Interne Durchflussmessungen](docs/durchflussmessung.md).

### Liquid Glass und laufende Messungen

Die Oberfläche nutzt transparente Glasflächen, Wasserfarben, eine schwebende Navigation und eine für Smartphones angepasste Darstellung. Login, Einrichtung, Kontoverwaltung, Listen, Messungen und Protokolle behalten ihre Funktionen und Berechtigungen. Sichtbare Demo-Hinweise und Demo-Schnellzugänge wurden aus der Oberfläche entfernt; vorhandene Datensätze werden dabei nicht verändert. Die Anwendung bleibt ein geschütztes internes Werkzeug der Stadtwerke Heppenheim.

Eine feste Messungsanzeige am unteren Bildschirmrand bleibt beim Navigieren sichtbar. Spül- und Durchflussmessungen erhalten jeweils eine eigene Karte mit Status und aktuellen Werten. Ein Klick öffnet den zugehörigen Spülpunkt bzw. die Durchflussmessung, ohne einen neuen Messauftrag zu starten. Bei Unterbrechungen oder noch ausstehender Speicherung bleibt die Karte mit entsprechendem Status sichtbar; veraltete Live-Werte werden nicht als aktuell angezeigt. Nach bestätigtem Abschluss verschwindet die jeweilige Karte. Betrachter, die Anmeldeseite und Ausdrucke zeigen diese Messungsdaten nicht. Reduzierte Bewegung und ein Fallback für Browser ohne Transparenzeffekte sind berücksichtigt.
