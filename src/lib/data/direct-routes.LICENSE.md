# Licence for `direct-routes.generated.json` and `direct-routes.audit.tsv`

These two files are derived from English Wikipedia and are therefore
**[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)**, not MIT.

Everything else in this repository stays MIT. This is the only share-alike file in it, and
the split is deliberate: the app's code owes nothing to Wikipedia, and the route graph owes
everything to it.

## What was taken

The `{{Airport-dest-list}}` tables from English Wikipedia's airport articles, read through
the MediaWiki API by `scripts/fetch-direct-routes.mjs`. Wikipedia text is licensed
[CC BY-SA 4.0](https://en.wikipedia.org/wiki/Wikipedia:Text_of_the_Creative_Commons_Attribution-ShareAlike_4.0_International_License).

The IATA-code-to-article mapping comes from [Wikidata](https://www.wikidata.org/) property
P238, which is [CC0](https://creativecommons.org/publicdomain/zero/1.0/) and carries no
condition.

## Attribution

Every row in `direct-routes.audit.tsv` names the exact Wikipedia article it was read from,
so any single edge can be traced back to its source article at
`https://en.wikipedia.org/wiki/<article>` without re-running anything.

## What share-alike means here

Redistributing these two files, or a work derived from them, means carrying this licence
with them. It does not reach the rest of the repository: the app links to the data, it is
not a derivative of it.
