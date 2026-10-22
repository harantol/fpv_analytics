# Publication sur le magasin F-Droid perso

Même fonctionnement que `auto_pid_tuning` : **chaque merge sur `main`** compile l'APK signé
avec la clé de release et l'attache à la release GitHub `vX.Y`. Le magasin F-Droid perso
(`magasin-fdroid` sur S13, http://192.168.1.15:8480) le récupère dans cette release.

- Nom de l'APK : `fpv-analytics-X.Y.apk`.
- Fiche dans le magasin (nom, descriptions, icône) : `fastlane/metadata/android/fr-FR/`.
- Notes de version : le titre de la PR mergée.
- Identifiant de l'app : `io.github.harantol.fpvanalytics`.

## Versions

- `versionName` = `MAJEUR.MINEUR` (`scripts/version.mjs`) : MAJEUR dans le fichier `VERSION`,
  MINEUR = nombre de merges sur `main` depuis le dernier changement de `VERSION`.
- `versionCode` = MAJEUR × 1000 + MINEUR (ex. `1.6` → `1006`) : il augmente à chaque version.

Chaque PR compile aussi un APK de test (artefact `fpv-analytics-debug-apk`, signé avec la clé
de debug : à installer à côté, pas par-dessus la version du magasin).

## La clé de signature (une seule fois)

Android n'installe une mise à jour que si elle est signée avec la même clé que l'app installée.
Comme pour auto_pid_tuning, un seul mot de passe sert au keystore et à la clé :

```bash
mkdir -p ~/fpv_analytics/android-signing && cd ~/fpv_analytics/android-signing   # sur S13
keytool -genkeypair -keystore fpv-analytics.keystore -alias fpv-analytics \
  -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=FPV Analytics"
# -> choisir un mot de passe ; à la question du mot de passe de la clé, faire Entrée (le même)
base64 -w0 fpv-analytics.keystore
```

Secrets du dépôt GitHub (*Settings → Secrets and variables → Actions*) :

| Secret | Valeur |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | la sortie de `base64 -w0 fpv-analytics.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | le mot de passe |

**Si la clé est perdue**, les nouvelles versions ne s'installent plus par-dessus l'ancienne :
il faut désinstaller l'app d'abord (les vols enregistrés dans l'app sont alors perdus).

## Côté magasin

- Ajouter `harantol/fpv_analytics` à la liste des dépôts suivis par `magasin-fdroid`,
  comme `harantol/auto_pid_tuning`.
- Le dépôt `fpv_analytics` est **privé** : pour lire ses releases, le magasin doit utiliser un
  jeton GitHub avec accès en lecture au dépôt — ou rendre le dépôt public comme auto_pid_tuning.

## Compiler en local (optionnel)

Prérequis : Node 22, JDK 21, Android SDK.

```bash
npm ci
npm run android:sync
cd android && ./gradlew assembleDebug
```

Pour un APK release signé en local, créer `android/keystore.properties` (ignoré par git) :

```properties
storeFile=/chemin/vers/fpv-analytics.keystore
password=...
```
