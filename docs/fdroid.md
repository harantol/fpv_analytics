# Publier sur votre dépôt F-Droid

La CI compile un **APK signé** à chaque release et l'ajoute à la release GitHub
(`fpv-analytics-vX.Y.Z.apk` + son empreinte `.sha256`). Votre serveur
fdroidserver n'a plus qu'à le récupérer.

## 1. Créer la clé de signature (une seule fois)

> Gardez précieusement cette clé et ses mots de passe : toutes les mises à jour
> doivent être signées avec la même clé, sinon Android refusera de les installer
> par-dessus l'ancienne version.

```bash
keytool -genkeypair -v -keystore fpv-analytics.jks -alias fpv-analytics \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 fpv-analytics.jks > fpv-analytics.jks.b64
```

## 2. Ajouter les secrets GitHub

*Settings → Secrets and variables → Actions → New repository secret* :

| Secret | Valeur |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | contenu de `fpv-analytics.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du keystore |
| `ANDROID_KEY_ALIAS` | `fpv-analytics` |
| `ANDROID_KEY_PASSWORD` | mot de passe de la clé (souvent le même) |

Autorisez aussi release-please à ouvrir sa PR : *Settings → Actions → General →
Workflow permissions* → **Allow GitHub Actions to create and approve pull requests**.

## 3. Faire une release

1. Mergez les PR dans `main` (messages de commit `feat:` / `fix:`).
2. release-please ouvre une PR « chore(main): release X.Y.Z » : mergez-la.
3. La CI crée le tag `vX.Y.Z`, compile l'APK signé et l'ajoute à la release.

## 4. Mettre à jour votre dépôt F-Droid

Une première fois, copiez `docs/fdroid-metadata.yml` dans
`metadata/io.github.harantol.fpvanalytics.yml` de votre dépôt fdroidserver.

Puis à chaque version :

```bash
cd ~/fdroid            # votre dépôt fdroidserver
TAG=v0.2.0             # version à publier
curl -LO "https://github.com/harantol/fpv_analytics/releases/download/$TAG/fpv-analytics-$TAG.apk"
curl -LO "https://github.com/harantol/fpv_analytics/releases/download/$TAG/fpv-analytics-$TAG.apk.sha256"
sha256sum -c "fpv-analytics-$TAG.apk.sha256" && mv "fpv-analytics-$TAG.apk" repo/
rm -f "fpv-analytics-$TAG.apk.sha256"
fdroid update
fdroid deploy          # si vous publiez vers un serveur distant
```

Les descriptions et l'icône sont aussi disponibles au format Fastlane dans
`fastlane/metadata/android/fr-FR/` (lu automatiquement par fdroidserver si vous
compilez depuis les sources avec `fdroid build`).

## Versions

- `versionName` = version de `package.json` (ex. `0.2.0`)
- `versionCode` = MAJ×10000 + MIN×100 + PATCH (ex. `0.2.0` → `200`, `1.3.2` → `10302`)

## Compiler en local (optionnel)

Prérequis : Node 22, JDK 21, Android SDK (Android Studio).

```bash
npm ci
npm run android:sync
cd android && ./gradlew assembleDebug    # APK de test non signé pour la release
```

Pour un APK release signé en local, créez `android/keystore.properties`
(ignoré par git) :

```properties
storeFile=/chemin/vers/fpv-analytics.jks
storePassword=...
keyAlias=fpv-analytics
keyPassword=...
```
