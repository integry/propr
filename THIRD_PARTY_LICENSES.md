Third-Party Licenses
====================

This file lists every third-party package bundled in the Propr Docker images,
its license, and (where required) the full license text.

Generated: 2026-06-30
See NOTICE for a higher-level summary and end-user obligations.

---

## Debian base image and system packages

The shared `propr/agent-base` image is based on `node:20-bookworm-slim` and
the agent image family installs system packages from Debian repositories,
including bash, build-essential, git, curl, ca-certificates, sudo, iptables,
procps, tini, ripgrep, gosu, and python3. GitHub CLI (`gh`) is installed from
the official GitHub CLI apt repository at cli.github.com.
See the Debian package tracker for per-package licensing details:
https://tracker.debian.org/

---

## @anthropic-ai/claude-code@2.1.191

```
© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.
```

## @anthropic-ai/sdk@0.71.2

```
Copyright 2023 Anthropic, PBC.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

## @openai/codex (installed in propr/agent-codex image)

Licensed under the Apache License, Version 2.0.
Source: https://github.com/openai/codex

## Antigravity CLI (installed in propr/agent-antigravity image)

Licensed under Google Terms of Service for Google Products and Antigravity
supplemental terms.
Source: https://codeassist.google/

## opencode-ai (installed in propr/agent-opencode image)

Licensed under the MIT License (verified from the published npm package metadata).
Source: https://github.com/sst/opencode


## mistral-vibe (installed in propr/agent-vibe image)

Licensed under the Apache License, Version 2.0.
Source: https://github.com/mistralai/mistral-vibe

---

## Apache License 2.0 (full text)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of tracking or improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

---

## All Propr npm production dependencies

Generated by `license-checker --production`. Each package listed
below is bundled in the propr/app image under the stated license.

```
├─ MIT: 244
├─ ISC: 14
├─ Apache-2.0: 7
├─ BSD-3-Clause: 4
├─ Custom: https://www.npmjs.com/package/: 2
├─ Custom: https://img.shields.io/badge/Node.js-18: 1
├─ UNKNOWN: 1
├─ BSD-2-Clause: 1
├─ (MIT OR WTFPL): 1
├─ MIT*: 1
├─ UNLICENSED: 1
├─ (BSD-2-Clause OR MIT OR Apache-2.0): 1
└─ 0BSD: 1

```

### Full per-package list

```
"module name","license","repository"
"@anthropic-ai/claude-code-linux-x64-musl@2.1.191","Custom: https://www.npmjs.com/package/",""
"@anthropic-ai/claude-code-linux-x64@2.1.191","Custom: https://www.npmjs.com/package/",""
"@anthropic-ai/claude-code@2.1.191","Custom: https://img.shields.io/badge/Node.js-18",""
"@anthropic-ai/sdk@0.71.2","MIT","https://github.com/anthropics/anthropic-sdk-typescript"
"@babel/runtime@7.28.4","MIT","https://github.com/babel/babel"
"@dnd-kit/accessibility@3.1.1","MIT","https://github.com/clauderic/dnd-kit"
"@dnd-kit/core@6.3.1","MIT","https://github.com/clauderic/dnd-kit"
"@dnd-kit/sortable@10.0.0","MIT","https://github.com/clauderic/dnd-kit"
"@dnd-kit/utilities@3.2.2","MIT","https://github.com/clauderic/dnd-kit"
"@ioredis/commands@1.4.0","MIT","https://github.com/ioredis/commands"
"@kwsites/file-exists@1.1.1","MIT","https://github.com/kwsites/file-exists"
"@kwsites/promise-deferred@1.1.1","MIT","https://github.com/kwsites/promise-deferred"
"@msgpackr-extract/msgpackr-extract-linux-x64@3.0.3","MIT","https://github.com/kriszyp/msgpackr-extract"
"@octokit/auth-app@8.0.1","MIT","https://github.com/octokit/auth-app.js"
"@octokit/auth-oauth-app@9.0.1","MIT","https://github.com/octokit/auth-oauth-app.js"
"@octokit/auth-oauth-device@8.0.3","MIT","https://github.com/octokit/auth-oauth-device.js"
"@octokit/auth-oauth-user@6.0.0","MIT","https://github.com/octokit/auth-oauth-user.js"
"@octokit/auth-token@6.0.0","MIT","https://github.com/octokit/auth-token.js"
"@octokit/core@7.0.2","MIT","https://github.com/octokit/core.js"
"@octokit/endpoint@11.0.3","MIT","https://github.com/octokit/endpoint.js"
"@octokit/graphql@9.0.1","MIT","https://github.com/octokit/graphql.js"
"@octokit/oauth-authorization-url@8.0.0","MIT","https://github.com/octokit/oauth-authorization-url.js"
"@octokit/oauth-methods@6.0.2","MIT","https://github.com/octokit/oauth-methods.js"
"@octokit/openapi-types@25.1.0","MIT","https://github.com/octokit/openapi-types.ts"
"@octokit/openapi-types@27.0.0","MIT","https://github.com/octokit/openapi-types.ts"
"@octokit/plugin-paginate-rest@13.1.1","MIT","https://github.com/octokit/plugin-paginate-rest.js"
"@octokit/request-error@7.1.0","MIT","https://github.com/octokit/request-error.js"
"@octokit/request@10.0.8","MIT","https://github.com/octokit/request.js"
"@octokit/types@14.1.0","MIT","https://github.com/octokit/types.ts"
"@octokit/types@16.0.0","MIT","https://github.com/octokit/types.ts"
"@propr/core@0.8.6","UNKNOWN",""
"@redis/bloom@1.2.0","MIT",""
"@redis/client@1.6.1","MIT","https://github.com/redis/node-redis"
"@redis/graph@1.1.1","MIT","https://github.com/redis/node-redis"
"@redis/json@1.0.7","MIT","https://github.com/redis/node-redis"
"@redis/search@1.2.0","MIT","https://github.com/redis/node-redis"
"@redis/time-series@1.1.0","MIT","https://github.com/redis/node-redis"
"@sec-ant/readable-stream@0.4.1","MIT","https://github.com/Sec-ant/readable-stream"
"@sindresorhus/merge-streams@4.0.0","MIT","https://github.com/sindresorhus/merge-streams"
"accepts@1.3.8","MIT","https://github.com/jshttp/accepts"
"array-flatten@1.1.1","MIT","https://github.com/blakeembrey/array-flatten"
"atomic-sleep@1.0.0","MIT","https://github.com/davidmarkclements/atomic-sleep"
"base64-js@1.5.1","MIT","https://github.com/beatgammit/base64-js"
"base64url@3.0.1","MIT","https://github.com/brianloveswords/base64url"
"before-after-hook@4.0.0","Apache-2.0","https://github.com/gr2m/before-after-hook"
"better-sqlite3@11.10.0","MIT","https://github.com/WiseLibs/better-sqlite3"
"bindings@1.5.0","MIT","https://github.com/TooTallNate/node-bindings"
"bl@4.1.0","MIT","https://github.com/rvagg/bl"
"body-parser@1.20.4","MIT","https://github.com/expressjs/body-parser"
"buffer-equal-constant-time@1.0.1","BSD-3-Clause","https://github.com/goinstant/buffer-equal-constant-time"
"buffer@5.7.1","MIT","https://github.com/feross/buffer"
"bullmq@5.65.1","MIT","https://github.com/taskforcesh/bullmq"
"bytes@3.1.2","MIT","https://github.com/visionmedia/bytes.js"
"call-bind-apply-helpers@1.0.2","MIT","https://github.com/ljharb/call-bind-apply-helpers"
"call-bound@1.0.4","MIT","https://github.com/ljharb/call-bound"
"chownr@1.1.4","ISC","https://github.com/isaacs/chownr"
"cluster-key-slot@1.1.2","Apache-2.0","https://github.com/Salakar/cluster-key-slot"
"colorette@2.0.19","MIT","https://github.com/jorgebucaran/colorette"
"colorette@2.0.20","MIT","https://github.com/jorgebucaran/colorette"
"commander@10.0.1","MIT","https://github.com/tj/commander.js"
"content-disposition@0.5.4","MIT","https://github.com/jshttp/content-disposition"
"content-type@1.0.5","MIT","https://github.com/jshttp/content-type"
"cookie-signature@1.0.7","MIT","https://github.com/visionmedia/node-cookie-signature"
"cookie@0.7.2","MIT","https://github.com/jshttp/cookie"
"cors@2.8.5","MIT","https://github.com/expressjs/cors"
"cron-parser@4.9.0","MIT","https://github.com/harrisiirak/cron-parser"
"cross-spawn@7.0.6","MIT","https://github.com/moxystudio/node-cross-spawn"
"dateformat@4.6.3","MIT","https://github.com/felixge/node-dateformat"
"debug@2.6.9","MIT","https://github.com/visionmedia/debug"
"debug@4.3.4","MIT","https://github.com/debug-js/debug"
"debug@4.4.3","MIT","https://github.com/debug-js/debug"
"decompress-response@6.0.0","MIT","https://github.com/sindresorhus/decompress-response"
"deep-extend@0.6.0","MIT","https://github.com/unclechu/node-deep-extend"
"denque@2.1.0","Apache-2.0","https://github.com/invertase/denque"
"depd@2.0.0","MIT","https://github.com/dougwilson/nodejs-depd"
"destroy@1.2.0","MIT","https://github.com/stream-utils/destroy"
"detect-libc@2.1.2","Apache-2.0","https://github.com/lovell/detect-libc"
"dotenv@16.5.0","BSD-2-Clause","https://github.com/motdotla/dotenv"
"dunder-proto@1.0.1","MIT","https://github.com/es-shims/dunder-proto"
"ecdsa-sig-formatter@1.0.11","Apache-2.0","https://github.com/Brightspace/node-ecdsa-sig-formatter"
"ee-first@1.1.1","MIT","https://github.com/jonathanong/ee-first"
"encodeurl@1.0.2","MIT","https://github.com/pillarjs/encodeurl"
"encodeurl@2.0.0","MIT","https://github.com/pillarjs/encodeurl"
"end-of-stream@1.4.4","MIT","https://github.com/mafintosh/end-of-stream"
"es-define-property@1.0.1","MIT","https://github.com/ljharb/es-define-property"
"es-errors@1.3.0","MIT","https://github.com/ljharb/es-errors"
"es-object-atoms@1.1.1","MIT","https://github.com/ljharb/es-object-atoms"
"escalade@3.2.0","MIT","https://github.com/lukeed/escalade"
"escape-html@1.0.3","MIT","https://github.com/component/escape-html"
"esm@3.2.25","MIT","https://github.com/standard-things/esm"
"etag@1.8.1","MIT","https://github.com/jshttp/etag"
"execa@9.6.1","MIT","https://github.com/sindresorhus/execa"
"expand-template@2.0.3","(MIT OR WTFPL)","https://github.com/ralphtheninja/expand-template"
"express-session@1.18.2","MIT","https://github.com/expressjs/session"
"express@4.22.1","MIT","https://github.com/expressjs/express"
"fast-content-type-parse@3.0.0","MIT","https://github.com/fastify/fast-content-type-parse"
"fast-copy@3.0.2","MIT","https://github.com/planttheidea/fast-copy"
"fast-levenshtein@3.0.0","MIT","https://github.com/hiddentao/fast-levenshtein"
"fast-redact@3.5.0","MIT","https://github.com/davidmarkclements/fast-redact"
"fast-safe-stringify@2.1.1","MIT","https://github.com/davidmarkclements/fast-safe-stringify"
"figures@6.1.0","MIT","https://github.com/sindresorhus/figures"
"file-uri-to-path@1.0.0","MIT","https://github.com/TooTallNate/file-uri-to-path"
"finalhandler@1.3.2","MIT","https://github.com/pillarjs/finalhandler"
"forwarded@0.2.0","MIT","https://github.com/jshttp/forwarded"
"fresh@0.5.2","MIT","https://github.com/jshttp/fresh"
"fs-constants@1.0.0","MIT","https://github.com/mafintosh/fs-constants"
"fs-extra@11.3.0","MIT","https://github.com/jprichardson/node-fs-extra"
"function-bind@1.1.2","MIT","https://github.com/Raynos/function-bind"
"generic-pool@3.9.0","MIT","https://github.com/coopernurse/node-pool"
"get-intrinsic@1.3.0","MIT","https://github.com/ljharb/get-intrinsic"
"get-package-type@0.1.0","MIT","https://github.com/cfware/get-package-type"
"get-proto@1.0.1","MIT","https://github.com/ljharb/get-proto"
"get-stream@9.0.1","MIT","https://github.com/sindresorhus/get-stream"
"getopts@2.3.0","MIT","https://github.com/jorgebucaran/getopts"
"github-from-package@0.0.0","MIT","https://github.com/substack/github-from-package"
"gopd@1.2.0","MIT","https://github.com/ljharb/gopd"
"graceful-fs@4.2.11","ISC","https://github.com/isaacs/node-graceful-fs"
"has-symbols@1.1.0","MIT","https://github.com/inspect-js/has-symbols"
"hasown@2.0.2","MIT","https://github.com/inspect-js/hasOwn"
"help-me@5.0.0","MIT","https://github.com/mcollina/help-me"
"http-errors@2.0.0","MIT","https://github.com/jshttp/http-errors"
"http-errors@2.0.1","MIT","https://github.com/jshttp/http-errors"
"human-signals@8.0.1","Apache-2.0","https://github.com/ehmicky/human-signals"
"iconv-lite@0.4.24","MIT","https://github.com/ashtuchkin/iconv-lite"
"ieee754@1.2.1","BSD-3-Clause","https://github.com/feross/ieee754"
"inherits@2.0.4","ISC","https://github.com/isaacs/inherits"
"ini@1.3.8","ISC","https://github.com/isaacs/ini"
"interpret@2.2.0","MIT","https://github.com/gulpjs/interpret"
"ioredis@5.8.2","MIT","https://github.com/luin/ioredis"
"ipaddr.js@1.9.1","MIT","https://github.com/whitequark/ipaddr.js"
"is-core-module@2.16.1","MIT","https://github.com/inspect-js/is-core-module"
"is-plain-obj@4.1.0","MIT","https://github.com/sindresorhus/is-plain-obj"
"is-stream@4.0.1","MIT","https://github.com/sindresorhus/is-stream"
"is-unicode-supported@2.1.0","MIT","https://github.com/sindresorhus/is-unicode-supported"
"isexe@2.0.0","ISC","https://github.com/isaacs/isexe"
"joycon@3.1.1","MIT","https://github.com/egoist/joycon"
"js-tiktoken@1.0.21","MIT","https://github.com/dqbd/tiktoken"
"json-schema-to-ts@3.1.1","MIT","https://github.com/ThomasAribart/json-schema-to-ts"
"json-with-bigint@3.5.7","MIT","https://github.com/Ivan-Korolenko/json-with-bigint"
"jsonfile@6.1.0","MIT","https://github.com/jprichardson/node-jsonfile"
"jsonwebtoken@9.0.2","MIT","https://github.com/auth0/node-jsonwebtoken"
"jwa@1.4.2","MIT","https://github.com/brianloveswords/node-jwa"
"jws@3.2.2","MIT","https://github.com/brianloveswords/node-jws"
"knex@3.1.0","MIT","https://github.com/knex/knex"
"lodash.defaults@4.2.0","MIT","https://github.com/lodash/lodash"
"lodash.includes@4.3.0","MIT","https://github.com/lodash/lodash"
"lodash.isarguments@3.1.0","MIT","https://github.com/lodash/lodash"
"lodash.isboolean@3.0.3","MIT","https://github.com/lodash/lodash"
"lodash.isinteger@4.0.4","MIT","https://github.com/lodash/lodash"
"lodash.isnumber@3.0.3","MIT","https://github.com/lodash/lodash"
"lodash.isplainobject@4.0.6","MIT","https://github.com/lodash/lodash"
"lodash.isstring@4.0.1","MIT","https://github.com/lodash/lodash"
"lodash.once@4.1.1","MIT","https://github.com/lodash/lodash"
"lodash@4.17.21","MIT","https://github.com/lodash/lodash"
"luxon@3.6.1","MIT","https://github.com/moment/luxon"
"math-intrinsics@1.1.0","MIT","https://github.com/es-shims/math-intrinsics"
"media-typer@0.3.0","MIT","https://github.com/jshttp/media-typer"
"merge-descriptors@1.0.3","MIT","https://github.com/sindresorhus/merge-descriptors"
"methods@1.1.2","MIT","https://github.com/jshttp/methods"
"mime-db@1.52.0","MIT","https://github.com/jshttp/mime-db"
"mime-types@2.1.35","MIT","https://github.com/jshttp/mime-types"
"mime@1.6.0","MIT","https://github.com/broofa/node-mime"
"mimic-response@3.1.0","MIT","https://github.com/sindresorhus/mimic-response"
"minimist@1.2.8","MIT","https://github.com/minimistjs/minimist"
"mkdirp-classic@0.5.3","MIT","https://github.com/mafintosh/mkdirp-classic"
"ms@2.0.0","MIT","https://github.com/zeit/ms"
"ms@2.1.2","MIT","https://github.com/zeit/ms"
"ms@2.1.3","MIT","https://github.com/vercel/ms"
"msgpackr-extract@3.0.3","MIT","https://github.com/kriszyp/msgpackr-extract"
"msgpackr@1.11.4","MIT","https://github.com/kriszyp/msgpackr"
"napi-build-utils@2.0.0","MIT","https://github.com/inspiredware/napi-build-utils"
"negotiator@0.6.3","MIT","https://github.com/jshttp/negotiator"
"node-abi@3.85.0","MIT","https://github.com/electron/node-abi"
"node-abort-controller@3.1.1","MIT","https://github.com/southpolesteve/node-abort-controller"
"node-gyp-build-optional-packages@5.2.2","MIT","https://github.com/prebuild/node-gyp-build"
"npm-run-path@6.0.0","MIT","https://github.com/sindresorhus/npm-run-path"
"oauth@0.10.2","MIT","https://github.com/ciaranj/node-oauth"
"object-assign@4.1.1","MIT","https://github.com/sindresorhus/object-assign"
"object-inspect@1.13.4","MIT","https://github.com/inspect-js/object-inspect"
"on-exit-leak-free@2.1.2","MIT","https://github.com/mcollina/on-exit-or-gc"
"on-finished@2.4.1","MIT","https://github.com/jshttp/on-finished"
"on-headers@1.1.0","MIT","https://github.com/jshttp/on-headers"
"once@1.4.0","ISC","https://github.com/isaacs/once"
"parse-ms@4.0.0","MIT","https://github.com/sindresorhus/parse-ms"
"parseurl@1.3.3","MIT","https://github.com/pillarjs/parseurl"
"passport-github2@0.1.12","MIT","https://github.com/cfsghost/passport-github"
"passport-oauth2@1.8.0","MIT","https://github.com/jaredhanson/passport-oauth2"
"passport-strategy@1.0.0","MIT","https://github.com/jaredhanson/passport-strategy"
"passport@0.7.0","MIT","https://github.com/jaredhanson/passport"
"path-key@3.1.1","MIT","https://github.com/sindresorhus/path-key"
"path-key@4.0.0","MIT","https://github.com/sindresorhus/path-key"
"path-parse@1.0.7","MIT","https://github.com/jbgutierrez/path-parse"
"path-to-regexp@0.1.12","MIT","https://github.com/pillarjs/path-to-regexp"
"pause@0.0.1","MIT*",""
"pg-connection-string@2.6.2","MIT","https://github.com/brianc/node-postgres"
"pino-abstract-transport@2.0.0","MIT","https://github.com/pinojs/pino-abstract-transport"
"pino-pretty@13.0.0","MIT","https://github.com/pinojs/pino-pretty"
"pino-std-serializers@7.0.0","MIT","https://github.com/pinojs/pino-std-serializers"
"pino@9.7.0","MIT","https://github.com/pinojs/pino"
"prebuild-install@7.1.3","MIT","https://github.com/prebuild/prebuild-install"
"pretty-ms@9.3.0","MIT","https://github.com/sindresorhus/pretty-ms"
"process-warning@5.0.0","MIT","https://github.com/fastify/process-warning"
"propr@0.8.6","UNLICENSED",""
"proxy-addr@2.0.7","MIT","https://github.com/jshttp/proxy-addr"
"pump@3.0.2","MIT","https://github.com/mafintosh/pump"
"qs@6.14.0","BSD-3-Clause","https://github.com/ljharb/qs"
"quick-format-unescaped@4.0.4","MIT","https://github.com/davidmarkclements/quick-format"
"random-bytes@1.0.0","MIT","https://github.com/crypto-utils/random-bytes"
"range-parser@1.2.1","MIT","https://github.com/jshttp/range-parser"
"raw-body@2.5.3","MIT","https://github.com/stream-utils/raw-body"
"rc@1.2.8","(BSD-2-Clause OR MIT OR Apache-2.0)","https://github.com/dominictarr/rc"
"react-dom@19.2.7","MIT","https://github.com/facebook/react"
"react@19.2.7","MIT","https://github.com/facebook/react"
"readable-stream@3.6.2","MIT","https://github.com/nodejs/readable-stream"
"real-require@0.2.0","MIT","https://github.com/pinojs/real-require"
"rechoir@0.8.0","MIT","https://github.com/gulpjs/rechoir"
"redis-errors@1.2.0","MIT","https://github.com/NodeRedis/redis-errors"
"redis-parser@3.0.0","MIT","https://github.com/NodeRedis/node-redis-parser"
"redis@4.7.1","MIT","https://github.com/redis/node-redis"
"resolve-from@5.0.0","MIT","https://github.com/sindresorhus/resolve-from"
"resolve@1.22.11","MIT","https://github.com/browserify/resolve"
"safe-buffer@5.2.1","MIT","https://github.com/feross/safe-buffer"
"safe-stable-stringify@2.5.0","MIT","https://github.com/BridgeAR/safe-stable-stringify"
"safer-buffer@2.1.2","MIT","https://github.com/ChALkeR/safer-buffer"
"scheduler@0.27.0","MIT","https://github.com/facebook/react"
"secure-json-parse@2.7.0","BSD-3-Clause","https://github.com/fastify/secure-json-parse"
"semver@7.7.3","ISC","https://github.com/npm/node-semver"
"send@0.19.0","MIT","https://github.com/pillarjs/send"
"send@0.19.1","MIT","https://github.com/pillarjs/send"
"serve-static@1.16.2","MIT","https://github.com/expressjs/serve-static"
"setprototypeof@1.2.0","ISC","https://github.com/wesleytodd/setprototypeof"
"shebang-command@2.0.0","MIT","https://github.com/kevva/shebang-command"
"shebang-regex@3.0.0","MIT","https://github.com/sindresorhus/shebang-regex"
"side-channel-list@1.0.0","MIT","https://github.com/ljharb/side-channel-list"
"side-channel-map@1.0.1","MIT","https://github.com/ljharb/side-channel-map"
"side-channel-weakmap@1.0.2","MIT","https://github.com/ljharb/side-channel-weakmap"
"side-channel@1.1.0","MIT","https://github.com/ljharb/side-channel"
"signal-exit@4.1.0","ISC","https://github.com/tapjs/signal-exit"
"simple-concat@1.0.1","MIT","https://github.com/feross/simple-concat"
"simple-get@4.0.1","MIT","https://github.com/feross/simple-get"
"simple-git@3.27.0","MIT","https://github.com/steveukx/git-js"
"sonic-boom@4.2.0","MIT","https://github.com/pinojs/sonic-boom"
"split2@4.2.0","ISC","https://github.com/mcollina/split2"
"standard-as-callback@2.1.0","MIT","https://github.com/luin/asCallback"
"statuses@2.0.1","MIT","https://github.com/jshttp/statuses"
"statuses@2.0.2","MIT","https://github.com/jshttp/statuses"
"string_decoder@1.3.0","MIT","https://github.com/nodejs/string_decoder"
"strip-final-newline@4.0.0","MIT","https://github.com/sindresorhus/strip-final-newline"
"strip-json-comments@2.0.1","MIT","https://github.com/sindresorhus/strip-json-comments"
"strip-json-comments@3.1.1","MIT","https://github.com/sindresorhus/strip-json-comments"
"supports-preserve-symlinks-flag@1.0.0","MIT","https://github.com/inspect-js/node-supports-preserve-symlinks-flag"
"tar-fs@2.1.4","MIT","https://github.com/mafintosh/tar-fs"
"tar-stream@2.2.0","MIT","https://github.com/mafintosh/tar-stream"
"tarn@3.0.2","MIT","https://github.com/vincit/tarn.js"
"thread-stream@3.1.0","MIT","https://github.com/mcollina/thread-stream"
"tildify@2.0.0","MIT","https://github.com/sindresorhus/tildify"
"toad-cache@3.7.0","MIT","https://github.com/kibertoad/toad-cache"
"toidentifier@1.0.1","MIT","https://github.com/component/toidentifier"
"ts-algebra@2.0.0","MIT","https://github.com/ThomasAribart/ts-algebra"
"tslib@2.8.1","0BSD","https://github.com/Microsoft/tslib"
"tunnel-agent@0.6.0","Apache-2.0","https://github.com/mikeal/tunnel-agent"
"type-is@1.6.18","MIT","https://github.com/jshttp/type-is"
"uid-safe@2.1.5","MIT","https://github.com/crypto-utils/uid-safe"
"uid2@0.0.4","MIT","https://github.com/coreh/uid2"
"undici@7.25.0","MIT","https://github.com/nodejs/undici"
"unicorn-magic@0.3.0","MIT","https://github.com/sindresorhus/unicorn-magic"
"universal-github-app-jwt@2.2.2","MIT","https://github.com/gr2m/universal-github-app-jwt"
"universal-user-agent@7.0.3","ISC","https://github.com/gr2m/universal-user-agent"
"universalify@2.0.1","MIT","https://github.com/RyanZim/universalify"
"unpipe@1.0.0","MIT","https://github.com/stream-utils/unpipe"
"util-deprecate@1.0.2","MIT","https://github.com/TooTallNate/util-deprecate"
"utils-merge@1.0.1","MIT","https://github.com/jaredhanson/utils-merge"
"uuid@11.1.0","MIT","https://github.com/uuidjs/uuid"
"vary@1.1.2","MIT","https://github.com/jshttp/vary"
"which@2.0.2","ISC","https://github.com/isaacs/node-which"
"wrappy@1.0.2","ISC","https://github.com/npm/wrappy"
"yallist@4.0.0","ISC","https://github.com/isaacs/yallist"
"yoctocolors@2.1.2","MIT","https://github.com/sindresorhus/yoctocolors"
"zod@4.3.6","MIT","https://github.com/colinhacks/zod"```
