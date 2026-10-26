#!/bin/sh
# Daily backup of the production site's runtime data to the NAS, run by the user timer
# deploy/systemd/pokemon-cn-backup.timer (04:17 every day; a run missed while the machine was off runs at boot):
#   $DATA/accounts.db → $NAS/backups/pokemon-cn-site/accounts/accounts-<UTC time>.db.gz   kept DB_DAYS days
#   $DATA/server.log  → $NAS/backups/pokemon-cn-site/logs/server-<UTC time>.log.gz        kept LOG_DAYS days
# The database is copied with SQLite's online backup while the site runs, switched to a single file (journal_mode
# DELETE), checked (integrity_check) and gzipped. The log is copied and emptied (start.sh appends to it, so the server
# goes on writing at its new end): each log file holds the lines since the previous backup, up to its time.
# Restore: stop the site, gunzip a backup over accounts.db (removing accounts.db-wal and -shm), start the site.
# By hand: systemctl --user start pokemon-cn-backup; output: journalctl --user -u pokemon-cn-backup
set -eu
DATA=${POKEMON_SITE_DATA:-$HOME/.local/share/pokemon-cn-site}
NAS=${POKEMON_NAS:-/nas/share/Pokemon}
dest=$NAS/backups/pokemon-cn-site
DB_DAYS=30 LOG_DAYS=90
stamp=$(date -u +%Y%m%dT%H%M%SZ)

# After a boot the NAS may still be mounting.
i=0
until [ -d "$NAS/backups" ]; do
  i=$((i + 1)); [ "$i" -le 90 ] || { echo "The NAS is not mounted ($NAS/backups)." >&2; exit 1; }
  sleep 2
done
mkdir -p "$dest/accounts" "$dest/logs"
tmp=$(mktemp -d /var/tmp/pokemon-cn-backup.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

# Copies $1 to the NAS as $2 (a temporary name first, so a half-written backup never carries the final name).
upload() {
  cp "$1" "$(dirname "$2")/.$(basename "$2").tmp"
  cmp -s "$1" "$(dirname "$2")/.$(basename "$2").tmp"
  mv "$(dirname "$2")/.$(basename "$2").tmp" "$2"
}

SRC="$DATA/accounts.db" DST="$tmp/accounts.db" "$HOME/.local/bin/node" --no-warnings -e '
const { DatabaseSync, backup } = require("node:sqlite");
(async () => {
  const src = new DatabaseSync(process.env.SRC, { readOnly: true });
  await backup(src, process.env.DST);
  src.close();
  const copy = new DatabaseSync(process.env.DST);
  copy.exec("PRAGMA journal_mode = DELETE");
  const check = copy.prepare("PRAGMA integrity_check").get().integrity_check;
  if (check !== "ok") throw new Error(`the copy fails integrity_check: ${check}`);
  const n = (table) => copy.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  console.log(`accounts.db: ${n("users")} users, ${n("decks")} decks, ${n("matches")} matches`);
  copy.close();
})().catch((error) => { console.error(`accounts.db: ${error.message}`); process.exit(1); });'
gzip -9 "$tmp/accounts.db"
upload "$tmp/accounts.db.gz" "$dest/accounts/accounts-$stamp.db.gz"
echo "→ $dest/accounts/accounts-$stamp.db.gz ($(stat -c %s "$tmp/accounts.db.gz") bytes)"

log=$DATA/server.log
if [ -s "$log" ]; then
  cp "$log" "$tmp/server.log" && : > "$log"
  gzip -9 "$tmp/server.log"
  if ! upload "$tmp/server.log.gz" "$dest/logs/server-$stamp.log.gz"; then
    mv "$tmp/server.log.gz" "$DATA/server-$stamp.log.gz"
    echo "server.log: the NAS copy failed; the lines are kept in $DATA/server-$stamp.log.gz" >&2
    exit 1
  fi
  echo "→ $dest/logs/server-$stamp.log.gz"
fi

# Older backups go only once today's are on the NAS.
find "$dest/accounts" -maxdepth 1 -name 'accounts-*.db.gz' -mtime +"$DB_DAYS" -print -delete
find "$dest/logs" -maxdepth 1 -name 'server-*.log.gz' -mtime +"$LOG_DAYS" -print -delete
