#!/usr/bin/env bash
# Re-runnable "are we done yet" check. See .audit/EXIT-PREDICATE.md.
# Fast by default (P1-P3). --full adds P4 and P5, which build the tree and take minutes.
cd /Users/maui/Projects/flights || exit 2
URL='https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO'
fails=0
say() { printf '%-8s %s\n' "$1" "$2"; [ "$1" = PASS ] || fails=$((fails + 1)); }

n=$(gh issue list --state open --limit 100 --json number --jq 'length' 2>/dev/null)
[ "$n" = 0 ] && say PASS "P1 open issues 0" || say FAIL "P1 open issues $n"

n=$(gh pr list --state open --limit 100 --json number --jq 'length' 2>/dev/null)
[ "$n" = 0 ] && say PASS "P2 open PRs 0" || say FAIL "P2 open PRs $n"

out=$(node tools/probe-results.mjs "$URL" 2>&1); rc=$?
count=$(printf '%s\n' "$out" | sed -n 's/^COUNT: \([0-9][0-9]*\) of.*/\1/p' | head -1)
if [ $rc -ne 0 ]; then
  say FAIL "P3 probe exited $rc (fixture leak or crash), measurement is not evidence"
else
  [ -n "$count" ] && [ "$count" -ge 1 ] 2>/dev/null && say PASS "P3a itineraries $count" || say FAIL "P3a itineraries ${count:-none}"
  # Anchored on the total line's own disclaimer, not on any occurrence of "priced".
  # The first version grepped for "No bed priced" and passed vacuously once the copy
  # changed. The second grepped for "not priced" anywhere and FAILED once beds started
  # working, because the total honestly says "excludes unpriced ground transport", which
  # is a different claim about a different thing. Both readings were wrong in opposite
  # directions, which is what a check gets for testing prose instead of the fact.
  if printf '%s\n' "$out" | grep -qi 'excludes an unpriced stay'; then
    say FAIL "P3b no bed in the total (total line still disclaims an unpriced stay)"
  else
    say PASS "P3b a bed is in the total"
  fi
  printf '%s\n' "$out" | grep -q 'console errors' && say FAIL "P3c console errors present" || say PASS "P3c no console errors"
fi

if [ "$1" = --full ]; then
  git fetch origin main -q
  for t in check build test qa; do
    if [ "$t" = qa ] && ! git show origin/main:package.json | grep -q '"qa"'; then
      printf '%-8s %s\n' PENDING "P4 pnpm qa not merged yet (#168)"; continue
    fi
    if pnpm "$t" >/tmp/pred-$t.log 2>&1; then say PASS "P4 pnpm $t"; else say FAIL "P4 pnpm $t (see /tmp/pred-$t.log)"; fi
  done
  if node tools/probe-sw-update.mjs >/tmp/pred-sw.log 2>&1; then say PASS "P5 returning visitor gets current build"; else say FAIL "P5 stale build served (see /tmp/pred-sw.log)"; fi
fi

echo "---"
[ "$fails" = 0 ] && echo "PREDICATE MET" || echo "PREDICATE NOT MET ($fails failing)"
exit "$fails"
