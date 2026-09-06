#!/usr/bin/env bash
# Re-runnable "is the owner's 2026-09-06 review answered yet" check.
# See .audit/EXIT-PREDICATE-OWNER-REVIEW.md. Fast by default; --full adds E4.
cd /Users/maui/Projects/flights || exit 2
fails=0
say() { printf '%-6s %s\n' "$1" "$2"; [ "$1" = PASS ] || fails=$((fails + 1)); }

open=$(gh issue list --state open --limit 100 --json number --jq '[.[].number] | map(select(. >= 404 and . <= 408)) | length' 2>/dev/null)
[ "$open" = 0 ] && say PASS "E1 review issues 404-408 all closed" || say FAIL "E1 $open of 404-408 still open"

prs=$(gh pr list --state open --limit 100 --json number --jq 'length' 2>/dev/null)
[ "$prs" = 0 ] && say PASS "E2 open PRs 0" || say FAIL "E2 open PRs $prs"

# E3 and E5 both come out of one production run. A SKIP is not a pass, and the tool says so
# itself, so the line to read is "could not be reached" as much as "failed".
out=$(node tools/verify-production.mjs 2>&1); rc=$?
printf '%s\n' "$out" | grep -E '^(FAIL|SKIP)' | sed 's/^/       /'
if [ $rc -eq 2 ]; then
  say FAIL "E5 measurement invalid (fixture leak), nothing below is evidence"
else
  printf '%s\n' "$out" | grep -q 'could not be reached\.$' && reached_line=$(printf '%s\n' "$out" | tail -1)
  unreached=$(printf '%s\n' "$out" | sed -n 's/.*, \([0-9][0-9]*\) could not be reached\./\1/p')
  [ "${unreached:-1}" = 0 ] && say PASS "E5 every check reached its subject" || say FAIL "E5 $unreached checks could not be reached"

  # A name that matches NO line is this file being wrong, not the app. Six hours after the
  # last drift repair, `a bed row states a duration` was renamed in verify-production.mjs and
  # this list still held the old string, which would have reported E3 red forever while the
  # app was fine. Same disease, same day, my own file. So an unmatched name says so.
  for c in "ground previews draw a coast" "a bed row states a journey time" "the stay list offers a sort key"; do
    if ! printf '%s\n' "$out" | grep -q "$c"; then
      say FAIL "E3 no check named '$c' ran at all — this predicate has drifted, fix it before reading it"
    elif printf '%s\n' "$out" | grep -q "^PASS.*$c"; then
      say PASS "E3 $c"
    else
      say FAIL "E3 $c"
    fi
  done
fi

if [ "$1" = --full ]; then
  git fetch origin main -q
  for t in check build test qa; do
    if pnpm "$t" >/tmp/owner-review-$t.log 2>&1; then say PASS "E4 pnpm $t"; else say FAIL "E4 pnpm $t (see /tmp/owner-review-$t.log)"; fi
  done
fi

echo "---"
[ "$fails" = 0 ] && echo "REVIEW ANSWERED" || echo "NOT ANSWERED YET ($fails failing)"
exit "$fails"
