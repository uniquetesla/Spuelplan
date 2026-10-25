# Interner Betrieb der Stadtwerke Heppenheim

SpülPilot ist ein zugangsbeschränktes Arbeitswerkzeug, kein öffentlicher Webauftritt. Von außen ist lediglich die Anmeldeseite erreichbar; alle Listen, Messwerte und Verwaltungsfunktionen erfordern ein persönliches Konto und passende serverseitig geprüfte Rechte. Konten werden ausschließlich durch die Administration angelegt. Es gibt keine öffentliche Registrierung. Die einmalige Ersteinrichtung benötigt einen lokalen Einrichtungsschlüssel. Suchmaschinen werden per HTTP-Header und Meta-Tag ausgeschlossen; den Datenschutz übernehmen Anmeldung und Berechtigungen.

Für ortsunabhängigen Zugriff stellt die IT eine eigene Domain mit HTTPS und gültigem Zertifikat bereit. `nginx.conf.example` ist eine Vorlage mit einer reservierten Beispieldomain, keine bereits installierte oder veröffentlichte Konfiguration. Der Node-Port wird nicht direkt ins Internet freigegeben. Auf einem anderen Rechner muss die lokale Datenbank auf einem persistenten Datenträger liegen.

Beispiel für den Node-Prozess hinter dem HTTPS-Proxy, mit ersetzter Domain:

```sh
NODE_ENV=production APP_ORIGIN=https://spuelpilot.example COOKIE_SECURE=true HOST=127.0.0.1 DB_PATH=/srv/spuelpilot/data/spuelpilot.sqlite npm start
```

Das Verzeichnis muss für das Dienstkonto beschreibbar sein. Bei `NODE_ENV=production` verweigert die Anwendung den Start ohne exakte HTTPS-Herkunft, sichere Cookies oder bei aktiviertem Demomodus. **Keine Demo-Datenbank** in diesen Betrieb übernehmen; persönliche Administrationskonten einrichten. Datenbanken und Sicherungen gehören nicht ins Git-Repository. Passwörter und Einrichtungsschlüssel nicht veröffentlichen.

Die IT entscheidet, ob zusätzlich ein Firmen-VPN oder ein zentraler Identity-Proxy mit Mehrfaktor-Anmeldung vorgeschaltet wird. Das ermöglicht den gewünschten Zugriff von unterwegs über die freigegebenen betrieblichen Zugangswege. Eine SSO-/MFA-Anbindung ist aktuell nicht Teil der Anwendung.

Regelmäßige, zugriffsgeschützte SQLite-Backups einschließlich konsistenter WAL-Daten einrichten und Wiederherstellung prüfen. Vor der ersten Durchgangsmigration eines vorhandenen Datenbestands wird automatisch eine konsistente Sicherung neben der Datenbank angelegt. Das ersetzt keinen laufenden Backupplan. Anwendung als überwachten Dienst mit Neustart nach Systemstart betreiben.

Domain, Zertifikate, Hosting, Firewall und eventuelle Firmen-Authentifizierung sind in dieser Arbeitsumgebung noch nicht eingerichtet. Die Anwendung ist damit nicht automatisch im Internet erreichbar.
