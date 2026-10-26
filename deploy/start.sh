#!/bin/sh
# Starts the production site from this repo: server/main.mjs on https://0.0.0.0:1028/ with accounts. Run by the user
# unit deploy/systemd/pokemon-cn-site.service (deploy/README.md):  systemctl --user restart pokemon-cn-site
# HTTPS because the game verifies its release with WebCrypto (secure contexts only).
# Not in git, in $DATA: cert.pem / key.pem, accounts.db and server.log (the last two backed up to the NAS daily by
# deploy/backup.sh). On the NAS ($NAS): the card library index with its thumbnails (the repo's .data/card-library links
# to it), the replays and the bug reports; site/ links to $NAS/website/site.
# Sign-up is closed while the site is in development: npm run user -- add <name> --db "$DATA/accounts.db".
DATA=${POKEMON_SITE_DATA:-$HOME/.local/share/pokemon-cn-site}
NAS=${POKEMON_NAS:-/nas/share/Pokemon}
cd "$(dirname "$0")/.." || exit 1
exec "$HOME/.local/bin/node" server/main.mjs --host 0.0.0.0 --port 1028 --cert "$DATA/cert.pem" --key "$DATA/key.pem" \
  --db "$DATA/accounts.db" --registration closed \
  --card-library "$NAS/card-library" --replay-dir "$NAS/replays" --bug-report-dir "$NAS/bug-reports" >> "$DATA/server.log" 2>&1
