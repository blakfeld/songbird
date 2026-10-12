#!/usr/bin/env bash
# First-launch setup for the Fly app described in deploy/README.md. Safe to re-run: every
# step checks what already exists, so a run that fails halfway can simply be repeated.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Read from fly.toml so the app name and region live in one place.
app="$(sed -nE "s/^app = '([^']+)'.*/\1/p" fly.toml)"
region="$(sed -nE "s/^primary_region = '([^']+)'.*/\1/p" fly.toml)"
volume="$(sed -nE "s/^ *source = '([^']+)'.*/\1/p" fly.toml)"
[[ -n $app && -n $region && -n $volume ]] || { echo "Couldn't read app, region or volume from fly.toml." >&2; exit 1; }
url="https://$app.fly.dev"

say() { printf '\n==> %s\n' "$*"; }
confirm() {
  local reply
  # Without a terminal (as in CI) nobody can answer, so destructive and optional steps are declined.
  [[ -t 0 ]] || { echo "$1 [y/N] n (no terminal)"; return 1; }
  read -r -p "$1 [y/N] " reply
  [[ $reply == [yY]* ]]
}

for tool in jq cargo curl; do
  command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }
done
fly=$(command -v fly || command -v flyctl) || { echo "flyctl is required: brew install flyctl" >&2; exit 1; }
# An app-scoped deploy token can fail whoami, which asks about a user; the app lookup below
# proves the token works instead.
if [[ -z ${FLY_API_TOKEN:-} ]] && ! "$fly" auth whoami >/dev/null 2>&1; then
  # A browser login can't finish without a terminal and would leave CI hanging.
  [[ -t 0 ]] || { echo "Not logged in to Fly; set FLY_API_TOKEN." >&2; exit 1; }
  "$fly" auth login
fi

# A failed listing must abort rather than read as "nothing exists": otherwise a network
# blip would create a second volume or replace the master key.
fly_json() {
  local out
  out="$("$fly" "$@" --json)" || return 1
  jq . <<<"$out" >/dev/null 2>&1 || { echo "Unexpected output from 'fly $*': $out" >&2; return 1; }
  printf '%s\n' "$out"
}
machines() {
  local out
  out="$("$fly" machine list -a "$app" --json)" || return 1
  # Some flyctl versions answer an app with no Machines in plain text rather than JSON.
  if jq -e 'type == "array"' <<<"$out" >/dev/null 2>&1; then printf '%s\n' "$out"; else echo '[]'; fi
}
# The Machine auto-stops when idle, and ssh goes around the proxy that would wake it.
wake() { curl -fsS "$url/readyz" >/dev/null; }

say "App $app"
"$fly" status -a "$app" >/dev/null 2>&1 || { echo "App $app not found; check fly.toml or run 'fly apps create $app'." >&2; exit 1; }

say "Volume $volume in $region"
volumes="$(fly_json volumes list -a "$app")"
if jq -e --arg n "$volume" --arg r "$region" 'any(.[]?; .name == $n and .region == $r)' <<<"$volumes" >/dev/null; then
  echo "Already exists."
else
  "$fly" volumes create "$volume" --region "$region" --size 1 --yes -a "$app"
fi

say "Secret SONGBIRD_MASTER_KEYS"
new_key=0
secrets="$(fly_json secrets list -a "$app")"
if jq -e 'any(.[]?; (.Name // .name) == "SONGBIRD_MASTER_KEYS")' <<<"$secrets" >/dev/null; then
  # Replacing it would make every user's stored AI key undecryptable.
  echo "Already set; leaving it alone."
else
  (cd backend && cargo build -q -p api)
  # Run outside backend/ with the variable unset, because the CLI loads backend/.env and a
  # local development keyring there would otherwise leak into, or break, the production key.
  key="$(cd "$(mktemp -d)" && env -u SONGBIRD_MASTER_KEYS "$root/backend/target/debug/api" keys generate-master-key)"
  [[ $key == v[0-9]*:* ]] || { echo "Key generation printed something unexpected." >&2; exit 1; }
  # Staged so the old Machine isn't restarted for nothing; the deploy below applies it.
  # Piped rather than passed as an argument so the key never shows up in ps or shell history.
  printf 'SONGBIRD_MASTER_KEYS=%s\n' "$key" | "$fly" secrets import --stage -a "$app"
  unset key
  new_key=1
fi

say "Machines without the volume"
# Fly can't add a volume to an existing Machine, and the deploy fails while one is left.
# Their data is on a filesystem every deploy wipes anyway, so nothing is lost.
stale="$(machines | jq -r '.[] | select((.config.mounts // []) | length == 0) | .id')"
if [[ -z $stale ]]; then
  echo "None."
else
  echo "$stale"
  if confirm "Destroy these Machines so the deploy can create one with the volume?"; then
    for id in $stale; do "$fly" machine destroy "$id" --force -a "$app"; done
  else
    echo "Leaving them; the deploy will likely fail until they're gone." >&2
  fi
fi

say "Deploy"
# --ha defaults to true and adds a spare Machine, which would get its own empty volume
# and so its own separate database.
"$fly" deploy --ha=false -a "$app"
count="$(machines | jq length)"
if (( count != 1 )); then
  # Not scaled down automatically: Fly might pick the Machine whose volume holds the data.
  echo "Expected 1 Machine but found $count; remove the extra one by hand (see deploy/README.md)." >&2
  exit 1
fi

say "Checks"
for _ in $(seq 1 30); do
  wake 2>/dev/null && break
  sleep 5
done
curl -fsS "$url/readyz" && echo
"$fly" ssh console -a "$app" -C "ls -l /app/data"

say "First user"
if confirm "Create a user now?"; then
  read -r -p "Email: " email
  # flyctl splits -C on shell-word rules, so anything that could change the split is refused.
  [[ $email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "That doesn't look like an email address." >&2; exit 1; }
  wake
  # --pty lets the CLI prompt for the password itself, hidden and confirmed, so it never
  # passes through this script. Run as songbird so SQLite's -wal/-shm files stay writable.
  "$fly" ssh console --pty -a "$app" \
    -C "setpriv --reuid=songbird --regid=songbird --init-groups songbird-api user create $email"
fi

if (( new_key )); then
  # The key went straight from the generator to Fly and was never shown, and Fly secrets
  # can't be read back from outside the Machine.
  say "Save the new master key"
  echo "Without it, users' stored AI keys can't be decrypted. Print it once and store it in a password manager:"
  echo "  fly ssh console -a $app -C \"printenv SONGBIRD_MASTER_KEYS\""
fi

say "Done: $url"
