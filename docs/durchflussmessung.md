# Interne Durchflussmessungen

## Bedienung

1. Als Mitarbeiter oder Administration **Durchflussmessung** öffnen und den ESP32 per Bluetooth verbinden.
2. **Neue Durchflussmessung** wählen, Adresse und optional eine Bemerkung eingeben und **Aufzeichnung starten** drücken.
3. Die Kurve zeigt den Durchfluss in m³/h über die verstrichene Messdauer. Der Durchfluss wird auch im Leerlauf des ESP32 erfasst; eine Sollmenge, ein Spülpunkt oder Temperaturangaben sind nicht erforderlich. Es gibt keine feste Aufzeichnungsdauer.
4. **Messung beenden** hält die Aufzeichnung an und speichert alle noch ausstehenden Werte. Erst nach bestätigter Serverspeicherung gilt die Messung als abgeschlossen. Das Diagramm lässt sich danach jederzeit erneut öffnen. Adresse und Bemerkung können bearbeitet und abgeschlossene Messungen nach Eingabe der Adresse gelöscht werden.

Mitarbeiter erstellen und verwalten ausschließlich ihre eigenen Messungen. Die Administration kann alle Messungen ansehen, ihre Angaben bearbeiten und abgeschlossene Messungen löschen. Eine laufende Aufzeichnung wird von der erfassenden Person beendet. Betrachter haben weder einen Menüpunkt noch Zugriff auf diese APIs. Die Durchflussmessungen erscheinen nicht in den Betrachter-Spülprotokollen und verändern keine Spülstatistik.

## Datenquelle und Unterbrechungen

Die bestehende TX-Characteristic liefert die bereits vereinbarten LIVE-Nachrichten, auch ohne Spülauftrag. Die Aufzeichnung verwendet ausschließlich den validierten Durchfluss. Temperaturwerte und Spülmengen aus diesen Telegrammen werden nicht in der Durchflussmessung gespeichert. Das Feature sendet keinen Messauftrag, keinen Nullmengen-Abbruch und kein ACK an den ESP32. Beim Bluetooth-Verbindungsaufbau bleibt die bestehende STATUS-Abfrage erhalten. Unabhängig vorhandene Spülaufträge behalten ihre bisherige Verarbeitung.

Die Webseite muss für eine durchgehende Aufzeichnung geöffnet und per Bluetooth verbunden bleiben. Bei Trennung, Bildschirm-/Browser-Suspendierung oder ungültigen/fehlenden Live-Daten werden keine Werte erfunden. Der nächste empfangene Wert behält seine echte Position auf der Zeitachse. Unterbrechungen über fünf Sekunden erscheinen als getrennte Kurvenabschnitte. Ein Schließen oder Neuladen der Seite beendet die Messung auf dem Server nicht; nach Anmeldung und Wiederverbindung kann sie über **Fortsetzen** wiederaufgenommen werden. Es gibt keinen nachträglichen Abruf fehlender Durchflusswerte aus dem ESP32, da dafür kein Firmware-Vertrag vereinbart ist.

Eine Messung nur auf einem Gerät/Browser gleichzeitig aufzeichnen. Innerhalb desselben Browsers verhindert ein Web Lock die gleichzeitige Erfassung in mehreren Tabs. Die serverseitigen Sequenzprüfungen verhindern zudem das Überschreiben durch widersprüchliche Übertragungen.

## Speicherung

Jeder Live-Wert wird zuerst mit Messungs-ID, fortlaufender Sequenznummer und verstrichenen Millisekunden in einer benutzerbezogenen IndexedDB-Warteschlange gesichert. Alle fünf Sekunden werden Pakete von höchstens 200 Werten übertragen. Nur eine passende Serverbestätigung entfernt Werte aus dieser Warteschlange. Netzwerkfehler und verlorene Antworten können deshalb erneut übertragen werden, ohne Duplikate anzulegen. Beim Beenden wird die gesamte Warteschlange übertragen, bevor die Abschlussanfrage mit der letzten Sequenznummer gesendet wird. Ein fehlgeschlagener Abschluss bleibt über **Speicherung erneut versuchen** wiederaufnehmbar, auch nach einem Seiten-Reload. Browserspeicher mit ausstehenden Messwerten nicht löschen.

Die Datenbank wird ausschließlich um die separaten Tabellen `flow_measurements` und `flow_samples` mit passenden Indizes ergänzt. Bestehende Spüllisten, Messungen und Benutzer bleiben erhalten. Gespeichert werden Eigentümer, Adresse, Bemerkung, Beginn/Abschluss sowie die nummerierten Durchflusswerte und deren Zeitachse. Temperaturen werden nicht gespeichert. Authentifizierung, Rollenprüfung, CSRF- und Herkunftsprüfung gelten für alle neuen Endpunkte.

Alle Rohwerte bleiben gespeichert. Für die Diagrammanzeige werden lange Messreihen auf bis zu 1.000 Punkte verdichtet; erste/letzte Werte, Minima, Maxima und Unterbrechungssegmente werden dabei berücksichtigt. Das Diagramm wird aus diesen dauerhaft gespeicherten Werten wiederhergestellt und an die Bildschirmgröße angepasst. Löschungen werden wie bei den vorhandenen Protokollen mit Zeitpunkt und Benutzer markiert; gelöschte Messungen sind über die Anwendung nicht mehr verfügbar.

## Prüfung

Automatisierte Tests prüfen Berechtigungen einschließlich direkter Betrachter-Zugriffe, unveränderliche und idempotente Messwerte, atomare Paketverarbeitung, vollständigen Abschluss, Serverneustart und Spitzen langer Messreihen. Die Browserprüfung verwendet einen simulierten BLE-Sensor und testet außerdem IndexedDB, Offlineübertragung nach Reload, echte Nulldurchflüsse, Bluetooth-Lücken, mobile Diagramme, Bearbeitung und bestätigte Löschung. Die physische BLE-Übertragung auf dem eingesetzten Smartphone muss weiterhin mit dem echten ESP32 geprüft werden.
