# SpülPilot – ESP32-BLE-Vertrag

Web Bluetooth ist in SpülPilot umgesetzt. Der physische ESP32 muss die unten vereinbarte Firmware und Sensorik bereitstellen. Die Website kann keine physische LED schalten, wenn die Firmware diesen Ablauf nicht implementiert. Tests in der Cloud verwenden ein simuliertes BLE-Gerät; ein Hardwaretest steht noch aus.

## Profil

| Eigenschaft                        | Wert                                   |
| ---------------------------------- | -------------------------------------- |
| Gerätename                         | `SpuelPilot-ESP32`                     |
| Service, im Advertising enthalten  | `5f6d0001-7ad8-4cb4-8cf5-909d54aa0001` |
| RX: Write / Write Without Response | `5f6d0002-7ad8-4cb4-8cf5-909d54aa0001` |
| TX: Read / Notify                  | `5f6d0003-7ad8-4cb4-8cf5-909d54aa0001` |

Die Anwendung abonniert TX-Notifications vor der ersten Übertragung. RX verwendet bevorzugt Write With Response, sonst Write Without Response. BLE-Pairing, falls von der Firmware verlangt, erfolgt über das Betriebssystem.

Nachrichten sind vollständige UTF-8-Strings ohne eckige Klammern und ohne Einheiten. Trennzeichen ist das Semikolon. Ausgehende Dezimalzahlen verwenden einen Punkt, keine Tausendertrennzeichen und keine wissenschaftliche Notation. `2.5` und `2.50` bezeichnen dieselbe Sollmenge; die Anwendung rundet den Sollwert nicht auf zwei Nachkommastellen. Antworten dürfen auch Dezimalkommas und abschließendes CR/LF verwenden. Eine Nachricht darf maximal 512 UTF-8-Bytes umfassen. IDs dürfen keine Semikolons, Steuerzeichen oder reservierten Befehlsnamen enthalten.

**Jede Notification muss genau eine vollständige Nachricht transportieren.** Die Firmware muss eine ausreichende ATT-MTU unterstützen bzw. aushandeln und Nachrichten vollständig senden. Ohne zusätzliche Paketlängen oder Endmarkierung lassen sich beliebig fragmentierte oder zusammengefasste Telegramme mit diesem Format nicht zuverlässig unterscheiden. Ein stilles Abschneiden ist unzulässig. Bei verlorener GET-Notification nutzt die Anwendung nach Zeitüberschreitung TX Read als Rückfallebene; auch der Read-Wert muss eine vollständige Nachricht enthalten.

## Befehle und Antworten

| Richtung     | Nachricht                  | Bedeutung                                                             |
| ------------ | -------------------------- | --------------------------------------------------------------------- |
| Browser → RX | `SP-1024;2.50`             | Auftrag mit Spülpunkt-ID und Sollmenge in m³                          |
| Browser → RX | `STATUS`                   | Aktuellen Messzustand erfragen                                        |
| Browser → RX | `GET`                      | Gespeichertes Ergebnis über TX Notify anfordern                       |
| Browser → RX | `ACK;SP-1024`              | Bereits auf dem Server gespeichertes Ergebnis bestätigen              |
| TX → Browser | `SP-1024;2.500;12.45;9.82` | ID; Istmenge m³; Temperatur vorher °C; Temperatur nachher °C          |
| TX → Browser | `STATUS;WAIT_FLOW;SP-1024` | Wartet auf mindestens 1 m³/h                                          |
| TX → Browser | `STATUS;COUNTDOWN;SP-1024` | 5-Sekunden-Wartezeit läuft                                            |
| TX → Browser | `STATUS;MEASURING;SP-1024` | Messung läuft                                                         |
| TX → Browser | `STATUS;READY;SP-1024`     | Messung vollständig; Status-LED leuchtet                              |
| TX → Browser | `STATUS;ACK_OK`            | Ergebnis bestätigt und gelöscht; LED aus                              |
| TX → Browser | `NONE`                     | Kein gespeichertes Ergebnis; keine vollständigen Messwerte übernehmen |

`STATUS` wird beim Verbinden gesendet. Während der Messung aktualisieren Status-Notifications die Anzeige, füllen aber keine Messwerte automatisch ein. Die Bedienperson fordert das Ergebnis ausdrücklich über den Button an. `GET`, `STATUS` und ein BLE-Verbindungsabbruch dürfen das gespeicherte Ergebnis nicht löschen und den Mengenzähler nicht neu starten.

## Mess- und Speicherablauf

1. In einer freigegebenen, aktiven Liste einen noch offenen Spülpunkt auswählen und **Bluetooth verbinden** drücken. Der Sende-Button ist nur bei vollständiger BLE-Verbindung aktiv.
2. **Spülpunkt an ESP32 senden** überträgt ID und Sollmenge. Die Anwendung prüft vorher mit GET auf ein unbestätigtes Ergebnis und überschreibt dieses nicht. Die Firmware muss neue Aufträge zusätzlich ablehnen, solange ein Auftrag läuft oder ein unbestätigtes Ergebnis vorliegt.
3. Der ESP32 zählt die Istmenge für diesen Auftrag ab Messbeginn. Sobald erstmals mindestens 1 m³/h erreicht werden, beginnt der 5-Sekunden-Countdown; danach wird die Vorher-Temperatur gespeichert. Beim Erreichen bzw. Überschreiten der Sollmenge wird die Nachher-Temperatur gespeichert. Ist die Messung vollständig, legt der ESP32 das Ergebnis ab und schaltet die LED ein. Fehlende Vorher-Messwerte dürfen kein vollständiges READY-Ergebnis erzeugen.
4. Bei leuchtender LED **Messdaten abrufen** drücken. Die Anwendung sendet GET und wartet auf eine TX-Notification. ID, Wertebereiche, Vollständigkeit und erreichte Sollmenge werden geprüft. Erst dann werden Istmenge und beide Temperaturen eingetragen. Diese Werte sind im Formular schreibgeschützt. Die Bedienperson ergänzt weiterhin Trübung Ja/Nein.
5. **Spülung speichern** schreibt die Daten mit eigener Übertragungs-ID in die Datenbank. Der Server prüft Benutzer, Freigabe, aktiven Durchgang, Spülpunkt-ID, Sollmenge und Messwerte. Datum und erfassende Person werden weiterhin serverseitig eingetragen; die Oberfläche zeigt keine Uhrzeit.
6. **Erst nach bestätigter Speicherung** erhält der Browser eine Speicherbestätigung und sendet ACK. Zuvor prüft er per GET, ob das Gerätemessergebnis genau zur gespeicherten ID, Menge und beiden Temperaturen passt. Erst ein passendes `ACK;ID` darf in der Firmware Ergebnis und LED löschen; die Firmware antwortet mit `STATUS;ACK_OK`. Ein ACK mit falscher ID darf nichts löschen.

Die Firmware ist für das physische Schalten der LED verantwortlich. Ein automatisches Schließen eines Ventils ist damit nicht beauftragt.

## Unterbrechungen und Wiederaufnahme

- Bei abgelehnter oder fehlgeschlagener Serverspeicherung wird **kein ACK** gesendet. Das ESP32-Ergebnis und seine LED bleiben erhalten.
- Wiederholte Speicheranfragen mit derselben Übertragungs-ID und denselben Werten liefern die ursprüngliche Speicherbestätigung, auch wenn die Liste inzwischen zur Admin-Prüfung übergegangen ist. Abweichende Werte oder andere Benutzer werden abgelehnt. So führt eine verlorene HTTP-Antwort nicht zu einem zweiten Protokoll.
- Ein lokaler Auftragsvermerk speichert ausschließlich Benutzerzuordnung, Spülpunkt-/Durchgangs-/Übertragungs-ID, Sollmenge und gegebenenfalls Protokoll-ID. Passwörter und eigentliche Messwerte werden nicht im Browserspeicher abgelegt. Nach Anmeldung mit demselben Konto kann ein Auftrag im selben Browser wieder aufgenommen werden. Den Browserspeicher bis zur Bestätigung nicht löschen.
- Bei unklarer Serverantwort steht unter **Geräte & Sensoren** die Aktion **Server-Speicherstatus prüfen** bereit. Die eigene Serverbestätigung ist auch nach dem Abschluss der Mitarbeiterfreigabe zugänglich; es werden darüber keine fremden oder unveröffentlichten Listen freigegeben.
- Bei ausstehendem ACK: denselben ESP32 verbinden und **Empfang am ESP32 bestätigen** drücken. Die Anwendung lädt die eigene Speicherbestätigung erneut vom Server. Wurde das Ergebnis bereits durch einen früheren ACK gelöscht und nur ACK_OK ging verloren, beendet ein bestätigtes NONE den lokalen Vorgang ohne einen zweiten Messauftrag.
- **Lokalen Auftrag verwerfen** sendet ausdrücklich keinen Abbruch- oder Löschbefehl an den ESP32. Bereits gespeicherte Gerätedaten bleiben erhalten; ein ausstehendes ACK kann damit nicht verworfen werden.

Da das vereinbarte Telegramm keine Auftrags- oder Durchgangs-ID enthält, kann die Website physisch unterschiedliche Messungen mit identischer Punkt-ID und identischen Messwerten nicht kryptografisch unterscheiden. Deshalb muss die Firmware unbestätigte Resultate vor Überschreiben schützen. Nur ein Gerät und ein aktiver Browser-Tab je Messauftrag verwenden. Der API-Wert `source=esp32` dokumentiert die Browserübernahme; er ist keine hardwareseitige Signatur.

## Browser und betrieblicher Zugriff

Web Bluetooth benötigt HTTPS und einen unterstützten Browser, beispielsweise Chrome auf Android oder kompatible Chromium-Desktop-Browser. iOS Safari unterstützt Web Bluetooth nicht. Für iPhones wäre eine gesonderte native App/Bridge nötig. Ohne Bluetooth bleibt die manuelle Erfassung verfügbar. Betrachter sehen weder den Gerätemenüpunkt noch Bluetooth-Bedienelemente.
