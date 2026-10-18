# Fiscord

Ein einfaches, werbefreies Discord-Ersatz-Projekt:

- Registrierung mit **Bestätigungs-E-Mail**
- Server erstellen, per **Einladungscode** beitreten
- Kanäle und Nachrichten in **Echtzeit**
- Datenbank, Auth und Realtime über **Supabase** (kostenloser Tarif reicht)
- Hosting als statische Seite über **GitHub Pages**

Es gibt kein Build-Tool. Die Dateien sind reines HTML, CSS und JavaScript.

```
fiscord/
├── index.html          Oberfläche
├── styles.css          Design (dunkles Theme)
├── app.js              Logik: Login, Server, Kanäle, Chat
├── config.js           DEINE Supabase-Zugangsdaten
└── supabase/
    └── schema.sql      Datenbank, Sicherheitsregeln, Funktionen
```

---

## 1. Supabase-Projekt anlegen

1. Auf [supabase.com](https://supabase.com) ein Konto erstellen und **New project** wählen.
2. Name, Datenbank-Passwort und Region festlegen. Das Projekt braucht einen Moment.

## 2. Datenbank einrichten

1. Im Supabase-Dashboard links **SQL Editor** → **New query** öffnen.
2. Den kompletten Inhalt von `supabase/schema.sql` einfügen.
3. **Run** klicken. Es sollte ohne Fehler durchlaufen.

## 3. E-Mail-Bestätigung prüfen

1. **Authentication** → **Sign In / Providers** → **Email**.
2. **Confirm email** muss aktiviert sein (ist standardmäßig so).

## 4. URLs für die Bestätigungs-Mail eintragen

Damit der Link in der Mail zurück auf deine Seite zeigt:

1. **Authentication** → **URL Configuration**.
2. **Site URL**: `https://DEIN-GITHUB-NAME.github.io/fiscord/`
3. Unter **Redirect URLs** dieselbe Adresse hinzufügen. Zum lokalen Testen zusätzlich `http://localhost:8080/` (oder den Port, den du nutzt).

## 5. Zugangsdaten in `config.js` eintragen

1. **Project Settings** → **API**.
2. **Project URL** in `SUPABASE_URL` eintragen.
3. Den Key **`anon` / `public`** in `SUPABASE_ANON_KEY` eintragen.

> Der `anon`-Key darf im Frontend stehen. Die Sicherheit kommt von den Row-Level-Security-Regeln im SQL-Skript. Den **`service_role`-Key** niemals in den Code schreiben.

## 6. Auf GitHub Pages veröffentlichen

1. Auf GitHub ein neues Repository anlegen, z. B. `fiscord` (öffentlich).
2. Den **Inhalt** des Ordners `fiscord/` hochladen (`index.html`, `styles.css`, `app.js`, `config.js`). Die Datei `schema.sql` schadet nicht, wird aber nicht gebraucht.
3. **Settings** → **Pages** → **Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, Folder = `/ (root)`.
4. Nach ein bis zwei Minuten ist die Seite unter `https://DEIN-GITHUB-NAME.github.io/fiscord/` erreichbar.

Falls du den Namen des Repos änderst, passt auch die URL aus Schritt 4 nicht mehr.

## 7. Testen

1. Seite öffnen, **Registrieren** wählen, Benutzername, E-Mail und Passwort eingeben.
2. Die Bestätigungs-Mail öffnen (auch den Spam-Ordner prüfen) und auf den Link klicken. Du landest angemeldet auf der Seite.
3. Mit **+** einen Server erstellen. Er bekommt automatisch den Kanal `allgemein`.
4. Über das 🔗-Symbol den Einladungscode kopieren. Ein zweiter Account kann mit **+ → Server beitreten** dem Server beitreten.
5. Nachrichten schreiben. Sie erscheinen bei allen Mitgliedern des Kanals sofort, ohne Neuladen.

---

## Hinweise

**E-Mail-Versand:** Supabase hat einen eingebauten E-Mail-Versand, der für Tests gedacht ist und nur wenige Mails pro Stunde erlaubt. Wenn du mehr Nutzer erwartest, richte unter **Project Settings → Authentication → SMTP Settings** einen eigenen Dienst ein, z. B. Resend, Brevo oder Postmark.

**Nur für Mitglieder sichtbar:** Server, Kanäle und Nachrichten sind durch Row-Level-Security geschützt. Fremde Nutzer können sie nicht lesen, auch nicht über die API.

**Rechte:** Nur der Besitzer eines Servers kann Kanäle erstellen und löschen. Jeder Nutzer kann nur als er selbst schreiben und eigene Mitgliedschaften verlassen.

**Bekannte Grenzen (bewusst weggelassen, um es schlank zu halten):**
- Kein Passwort-Reset („Passwort vergessen“). Das lässt sich über `supabase.auth.resetPasswordForEmail` nachrüsten.
- Keine Dateianhänge, Sprachchats, Direktnachrichten oder Rollen.
- Nachrichten werden in Kanälen geladen, die letzten 50. Ältere Nachrichten sind noch nicht über Scrollen abrufbar.
- Nachrichten, die genau zwischen Laden und Abonnieren eines Kanals eintreffen, können fehlen. Ein erneutes Öffnen des Kanals zeigt sie.
- Nachrichten im Chat zeigen nur Text. Löschen und Bearbeiten fehlen in der Oberfläche.

## Fehlersuche

| Problem | Lösung |
|---|---|
| „Bitte trage zuerst deine Supabase-URL ein“ | `config.js` ausfüllen |
| Bestätigungslink führt zu `localhost` oder einer Fehlerseite | Site URL und Redirect URLs in Schritt 4 prüfen |
| „Benutzername ist schon vergeben“ | Anderen Namen wählen |
| Registrierung schlägt mit „Database error saving new user“ fehl | `schema.sql` vollständig ausführen, besonders den Trigger `on_auth_user_created` |
| Nachrichten erscheinen nicht live | Im SQL Editor prüfen, ob `alter publication supabase_realtime add table public.messages;` ausgeführt wurde |
