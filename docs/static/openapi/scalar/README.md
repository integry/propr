# Vendored Scalar API reference renderer

`standalone.js` is `dist/browser/standalone.js` from
[`@scalar/api-reference@1.73.0`](https://www.npmjs.com/package/@scalar/api-reference/v/1.73.0),
copied byte for byte (MIT License, Copyright (c) Scalar). It is served with the docs
so `../index.html` renders without network access, including in the bundled copy that
`propr docs` serves.

`test/openapiReferencePage.test.mjs` checks that the `integrity` hash in `../index.html`
matches this file. The hash equals the one jsDelivr serves for the published package:

```text
sha384-OKyMdsDX84ypSZEhVun8YElXk5c2GQaH3EXPOc6ItmVcLDUAvKHYwvDLvAgsqVtB
```

To upgrade, replace the file with the same path from the new release
(`npm pack @scalar/api-reference@<version>`), then update the version here and
in `../index.html`, and the `integrity` hash in `../index.html`.
