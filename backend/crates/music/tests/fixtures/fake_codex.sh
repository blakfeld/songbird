#!/bin/sh
# Stands in for the real `codex` CLI. Tests symlink this script into a temp
# directory that holds a `mode` file and a `response.json`, so no test ever
# writes to an executable (which races with process spawning).
dir=$(dirname "$0")
mode=$(cat "$dir/mode")

if [ "$1" = "login" ]; then
  if [ "$mode" = "login_hang" ]; then exec sleep 30; fi
  if [ "$mode" = "signed_out" ]; then
    echo "Not logged in" >&2
    exit 1
  fi
  echo "Logged in using ChatGPT"
  exit 0
fi

printf '%s\n' "$*" >> "$dir/args.log"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then out="$2"; fi
  shift
done
cat > "$dir/stdin.log"

case "$mode" in
  ok) cp "$dir/response.json" "$out" ;;
  invalid) echo "this is not json" > "$out" ;;
  fail) echo "boom" >&2; exit 3 ;;
  hang)
    # A grandchild like the real launcher's native child; its pid lets tests
    # prove the whole process group was killed, not just this shell.
    sleep 30 &
    echo $! > "$dir/grandchild.pid"
    wait
    ;;
  slow)
    [ -e "$dir/busy" ] && touch "$dir/overlap"
    touch "$dir/busy"
    sleep 0.4
    rm "$dir/busy"
    cp "$dir/response.json" "$out"
    ;;
esac
