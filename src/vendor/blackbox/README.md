# Parseur Blackbox de Betaflight

Modules copiés sans modification depuis le Blackbox Explorer de Betaflight
(<https://github.com/betaflight/blackbox-log-viewer>, licence GPL-3.0-or-later),
commit `a84755c5e897c1a3a580424b64c0df066c12c6b4` (septembre 2026) :

- `flightlog_parser.js`, `datastream.js`, `decoders.js`, `flightlog_fielddefs.js`, `tools.js`

Seul ajout : `flightlog_fields_presenter.js`, une souche qui remplace le module
d'origine (lié à l'interface Vue du Blackbox Explorer). Le parseur ne l'utilise
que pour renommer les champs de debug, inutiles ici.

## Mise à jour

Copier les 5 fichiers depuis `src/` d'une version plus récente du Blackbox Explorer,
remettre l'en-tête (origine, commit, `// @ts-nocheck`), puis lancer `npm test`.
