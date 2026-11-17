# Plugin contract fixtures

`breaking-previous.json` is a made-up earlier snapshot of the plugin interface
that promised things the current interface no longer offers: a removed or
retyped manifest field, a field made required, a dropped enum value, removed or
retyped event payload keys, a removed event type, a removed `ctx` member and
`ctx.propr` operation, a changed permission and removed input fields, error
codes and exports. `pluginContract.test.ts` compares the current interface
with it and expects `comparePluginContract` to report every one of them as a
breaking change: the same comparison the contract test runs against the
committed snapshot in `../../contracts/`.
